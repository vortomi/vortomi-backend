import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { TEMPLATE_CATEGORIES, type TemplateStatus } from '../../db/schema/enums.ts'
import { channelAccounts, messageTemplates } from '../../db/schema/index.ts'
import { withMember, type MemberScope } from '../access/member-scope.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'
import { WhatsAppApiError, type TemplateRegistry } from '../whatsapp/cloud-api.client.ts'
import type { TemplateStatusEvent } from '../whatsapp/events.ts'
import { InvalidTemplateError, parameterCount } from './template-body.ts'

export const templateInput = z.object({
  // Meta's rule for names: lower case, digits and underscores.
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('es'),
  category: z.enum(TEMPLATE_CATEGORIES),
  body: z.string().trim().min(1).max(1024),
  bodyExample: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  // Only needed when the company has more than one WhatsApp Business Account.
  wabaId: z.string().regex(/^\d+$/).optional(),
})
export type TemplateInput = z.infer<typeof templateInput>

/** Meta's review events -> our status. Unknown events leave the template as it is. */
const META_EVENTS: Record<string, TemplateStatus> = {
  APPROVED: 'approved',
  REINSTATED: 'approved',
  REJECTED: 'rejected',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  PENDING_DELETION: 'disabled',
}

const columns = {
  id: messageTemplates.id,
  wabaId: messageTemplates.wabaId,
  name: messageTemplates.name,
  language: messageTemplates.language,
  category: messageTemplates.category,
  status: messageTemplates.status,
  rejectionReason: messageTemplates.rejectionReason,
  submitError: messageTemplates.submitError,
  body: messageTemplates.body,
  bodyExample: messageTemplates.bodyExample,
}

/**
 * The company's templates. Creating one follows the outbound pattern: store it
 * (company transaction), submit it to Meta (no transaction), record Meta's answer
 * (new company transaction). Meta's verdict arrives later by webhook (applyStatus).
 */
export class TemplateService {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly registry: TemplateRegistry,
  ) {}

  list(scope: MemberScope) {
    return scope.tx
      .select(columns)
      .from(messageTemplates)
      .where(eq(messageTemplates.tenantId, scope.tenantId))
      .orderBy(asc(messageTemplates.name), asc(messageTemplates.language))
  }

  async submit(tenantId: string, userId: string, input: TemplateInput) {
    if (parameterCount(input.body) !== input.bodyExample.length) throw new InvalidTemplateError('one example per parameter')

    const draft = await withMember(this.db, tenantId, userId, async (scope) => {
      if (scope.member.role !== 'admin') throw new TemplateAdminRequiredError()
      const wabaId = await this.wabaOf(scope, input.wabaId)
      const [row] = await scope.tx
        .insert(messageTemplates)
        .values({ tenantId, wabaId, name: input.name, language: input.language, category: input.category, body: input.body, bodyExample: input.bodyExample })
        .returning({ id: messageTemplates.id, wabaId: messageTemplates.wabaId })
      return row!
    })

    let outcome: { metaTemplateId: string; status: TemplateStatus } | { submitError: string }
    try {
      const accessToken = await this.credentials.accessTokenForWaba(tenantId, draft.wabaId)
      if (!accessToken) {
        outcome = { submitError: 'no_credentials' }
      } else {
        const answer = await this.registry.submitTemplate({ ...input, wabaId: draft.wabaId, accessToken })
        outcome = { metaTemplateId: answer.metaTemplateId, status: META_EVENTS[answer.status.toUpperCase()] ?? 'pending' }
      }
    } catch (error) {
      outcome = { submitError: error instanceof WhatsAppApiError ? error.message.slice(0, 300) : 'unexpected_error' }
    }

    return withTenant(this.db, tenantId, async ({ tx }) => {
      const [row] = await tx
        .update(messageTemplates)
        .set({ ...outcome, updatedAt: sql`now()` })
        .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, draft.id)))
        .returning(columns)
      return row!
    })
  }

  /** Meta's verdict on a template of this company (routed by WABA id). */
  async applyStatus(scope: TenantScope, event: TemplateStatusEvent): Promise<void> {
    const status = META_EVENTS[event.event]
    if (!status) return
    await scope.tx
      .update(messageTemplates)
      .set({ status, rejectionReason: status === 'rejected' ? event.reason : null, updatedAt: sql`now()` })
      .where(
        and(
          eq(messageTemplates.tenantId, scope.tenantId),
          eq(messageTemplates.wabaId, event.wabaId),
          eq(messageTemplates.metaTemplateId, event.metaTemplateId),
        ),
      )
  }

  /** The WABA a new template goes to: the one asked for, or the company's only one. */
  private async wabaOf(scope: MemberScope, requested: string | undefined): Promise<string> {
    const wabas = await scope.tx
      .selectDistinct({ wabaId: channelAccounts.wabaId })
      .from(channelAccounts)
      .where(eq(channelAccounts.tenantId, scope.tenantId))
    const ids = wabas.map((row) => row.wabaId)
    if (requested) {
      if (!ids.includes(requested)) throw new InvalidTemplateError('unknown WhatsApp Business Account')
      return requested
    }
    if (ids.length !== 1) throw new InvalidTemplateError('choose the WhatsApp Business Account')
    return ids[0]!
  }
}

export class TemplateAdminRequiredError extends Error {
  constructor() {
    super('Only admins create templates')
    this.name = 'TemplateAdminRequiredError'
  }
}

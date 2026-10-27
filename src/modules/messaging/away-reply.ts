import { createHash } from 'node:crypto'
import { and, eq, gt, or, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../db/client.ts'
import { channelAccounts, contacts, conversations, messages, tenantSettings, tenants } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'
import type { WhatsAppSender } from '../whatsapp/cloud-api.client.ts'
import { isOpenAt } from './business-hours.ts'
import { describeSendError } from './outbound.service.ts'

/** A message stored later than this (recovered after an outage) gets no automatic answer. */
const FRESH_MS = 10 * 60_000
/** At most one automatic answer per conversation in this span: a chatty customer gets it once. */
const QUIET_MS = 12 * 60 * 60_000
/** Someone of the team answered this recently: they are attending, closed or not. */
const TEAM_ACTIVE_MS = 60 * 60_000

/** The customer message that may deserve the away message. */
export interface InboundTrigger {
  conversationId: string
  waMessageId: string
  /** When the customer wrote it (WhatsApp's timestamp). */
  timestamp: Date
}

interface Draft {
  messageId: number
  channelAccountId: string
  phoneNumberId: string
  to: string
  body: string
}

/**
 * The company's "mensaje fuera de horario": sent by itself when a customer writes while the
 * company is closed (its schedule, its time zone). Stored as a bot message, like any reply,
 * then handed to Meta outside the transaction, exactly as OutboundService does. Its id comes
 * from the customer's message, so the same webhook processed twice answers once.
 */
export class AwayReplyService {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly sender: WhatsAppSender,
    private readonly log: Pick<FastifyBaseLogger, 'error'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Runs after a NEW customer message is stored. Never throws: that message is already safe. */
  async afterInbound(tenantId: string, trigger: InboundTrigger): Promise<void> {
    try {
      await this.reply(tenantId, trigger)
    } catch (error) {
      this.log.error({ err: error, tenantId, conversationId: trigger.conversationId }, 'Away reply failed')
    }
  }

  private async reply(tenantId: string, trigger: InboundTrigger): Promise<void> {
    if (this.now().getTime() - trigger.timestamp.getTime() > FRESH_MS) return
    const draft = await withTenant(this.db, tenantId, (scope) => this.prepare(scope, trigger))
    if (!draft) return

    let result: { waMessageId: string } | { error: string }
    try {
      const accessToken = await this.credentials.accessTokenFor(tenantId, draft.channelAccountId)
      result = accessToken
        ? await this.sender.sendText({ phoneNumberId: draft.phoneNumberId, accessToken, to: draft.to, body: draft.body })
        : { error: 'no_credentials' }
    } catch (error) {
      result = { error: describeSendError(error) }
    }
    await withTenant(this.db, tenantId, ({ tx }) =>
      tx
        .update(messages)
        .set('waMessageId' in result ? { waMessageId: result.waMessageId } : { sendError: result.error })
        .where(and(eq(messages.tenantId, tenantId), eq(messages.id, draft.messageId))),
    )
  }

  /** Decides and stores the answer inside the company; null when nothing is to be sent. */
  private async prepare(scope: TenantScope, trigger: InboundTrigger): Promise<Draft | null> {
    const { tx, tenantId } = scope
    const [company] = await tx
      .select({ timezone: tenants.timezone, awayMessage: tenantSettings.awayMessage, businessHours: tenantSettings.businessHours })
      .from(tenants)
      .innerJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId))
    if (!company?.awayMessage.trim() || isOpenAt(company.businessHours, trigger.timestamp, company.timezone)) return null

    const now = this.now()
    const [recent] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, trigger.conversationId),
          eq(messages.direction, 'out'),
          or(
            and(eq(messages.author, 'bot'), gt(messages.createdAt, new Date(now.getTime() - QUIET_MS))),
            and(eq(messages.author, 'staff'), gt(messages.createdAt, new Date(now.getTime() - TEAM_ACTIVE_MS))),
          ),
        ),
      )
      .limit(1)
    if (recent) return null

    const [target] = await tx
      .select({ channelAccountId: contacts.channelAccountId, phoneNumberId: channelAccounts.phoneNumberId, to: contacts.waId })
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .innerJoin(channelAccounts, and(eq(channelAccounts.tenantId, contacts.tenantId), eq(channelAccounts.id, contacts.channelAccountId)))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, trigger.conversationId)))
    if (!target) return null

    const body = company.awayMessage.trim()
    const [stored] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: trigger.conversationId,
        clientMessageId: awayReplyId(trigger.waMessageId),
        direction: 'out',
        author: 'bot',
        type: 'text',
        body,
      })
      .onConflictDoNothing({ target: [messages.tenantId, messages.clientMessageId] })
      .returning({ id: messages.id })
    if (!stored) return null

    await tx
      .update(conversations)
      .set({ lastActivityAt: sql`now()` })
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, trigger.conversationId)))
    return { messageId: stored.id, ...target, body }
  }
}

/** A uuid fixed by the customer's message: the second attempt to answer it hits the unique key. */
function awayReplyId(waMessageId: string): string {
  const hex = createHash('sha256').update(`away-reply:${waMessageId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

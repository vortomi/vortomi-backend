import { and, eq, gt, or } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../db/client.ts'
import { messages, tenantSettings, tenants } from '../../db/schema/index.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'
import { type BotDelivery, type BotDraft, botMessageId, findTarget, storeBotText } from './bot-delivery.ts'
import { isOpenAt } from './business-hours.ts'

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
  /** What it was (text, image…) and its file, when it carries one. */
  type?: string
  waMediaId?: string | null
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
    private readonly delivery: BotDelivery,
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
    if (draft) await this.delivery.deliver(tenantId, draft)
  }

  /** Decides and stores the answer inside the company; null when nothing is to be sent. */
  private async prepare(scope: TenantScope, trigger: InboundTrigger): Promise<BotDraft | null> {
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

    const target = await findTarget(tx, tenantId, trigger.conversationId)
    if (!target) return null

    const body = company.awayMessage.trim()
    const messageId = await storeBotText(tx, tenantId, trigger.conversationId, botMessageId('away-reply', trigger.waMessageId), body)
    return messageId === null ? null : { messageId, ...target, body }
  }
}

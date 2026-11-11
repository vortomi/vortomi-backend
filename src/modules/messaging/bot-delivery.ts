import type { FastifyBaseLogger } from 'fastify'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { Database, Executor } from '../../db/client.ts'
import { channelAccounts, contacts, conversations, messages } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import type { ImageMessage, TypingIndicator, WhatsAppSender } from '../whatsapp/cloud-api.client.ts'
import { withTenant } from '../tenancy/tenant-scope.ts'
import { describeSendError } from './outbound.service.ts'

// What every automatic answer (the away message, the sales agent) does the same way: store a bot
// message inside the company's transaction, then hand it to Meta outside of it, exactly as
// OutboundService does for the team.

/** Where an answer to this conversation goes. */
export interface BotTarget {
  channelAccountId: string
  phoneNumberId: string
  to: string
}

/** A bot message already stored, waiting to be handed to Meta. */
export interface BotDraft extends BotTarget {
  messageId: number
  /** The text, or the caption of the image. */
  body: string
  image?: ImageMessage['image']
}

export async function findTarget(tx: Executor, tenantId: string, conversationId: string): Promise<BotTarget | null> {
  const [target] = await tx
    .select({ channelAccountId: contacts.channelAccountId, phoneNumberId: channelAccounts.phoneNumberId, to: contacts.waId })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
    .innerJoin(channelAccounts, and(eq(channelAccounts.tenantId, contacts.tenantId), eq(channelAccounts.id, contacts.channelAccountId)))
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
  return target ?? null
}

/**
 * Stores the bot's text (or the caption of its image); null when that answer was already stored
 * (its id repeats). Moves the conversation up the inbox like any message.
 */
export async function storeBotText(tx: Executor, tenantId: string, conversationId: string, clientMessageId: string, body: string, type: 'text' | 'image' = 'text'): Promise<number | null> {
  const [stored] = await tx
    .insert(messages)
    .values({ tenantId, conversationId, clientMessageId, direction: 'out', author: 'bot', type, body })
    .onConflictDoNothing({ target: [messages.tenantId, messages.clientMessageId] })
    .returning({ id: messages.id })
  if (!stored) return null
  await tx
    .update(conversations)
    .set({ lastActivityAt: sql`now()` })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
  return stored.id
}

/** Sends a stored bot message and writes down what Meta said. Never throws for Meta's errors. */
export class BotDelivery {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly sender: WhatsAppSender,
    private readonly typing: TypingIndicator | null = null,
    /** Where a refused send is told (the reason is also kept on the message for the panel). */
    private readonly log: Pick<FastifyBaseLogger, 'warn'> | null = null,
  ) {}

  /** "escribiendo…" for the customer while the answer is prepared. Best effort: never throws. */
  async showTyping(tenantId: string, target: BotTarget, waMessageId: string): Promise<void> {
    if (!this.typing) return
    try {
      const accessToken = await this.credentials.accessTokenFor(tenantId, target.channelAccountId)
      if (accessToken) await this.typing.showTyping({ phoneNumberId: target.phoneNumberId, accessToken, waMessageId })
    } catch {
      // Only a courtesy: the answer goes out the same.
    }
  }

  async deliver(tenantId: string, draft: BotDraft): Promise<void> {
    let result: { waMessageId: string } | { error: string }
    try {
      const accessToken = await this.credentials.accessTokenFor(tenantId, draft.channelAccountId)
      const { phoneNumberId, to, body, image } = draft
      if (!accessToken) result = { error: 'no_credentials' }
      else if (image) result = await this.sender.sendImage({ phoneNumberId, accessToken, to, image, caption: body })
      else result = await this.sender.sendText({ phoneNumberId, accessToken, to, body })
    } catch (error) {
      result = { error: describeSendError(error) }
    }
    if ('error' in result) this.log?.warn({ tenantId, messageId: draft.messageId, reason: result.error }, 'Automatic message not sent')
    await withTenant(this.db, tenantId, ({ tx }) =>
      tx
        .update(messages)
        .set('waMessageId' in result ? { waMessageId: result.waMessageId } : { sendError: result.error })
        .where(and(eq(messages.tenantId, tenantId), eq(messages.id, draft.messageId))),
    )
  }
}

/** A uuid fixed by the customer's message and the kind of answer: answering it twice hits the unique key. */
export function botMessageId(kind: string, waMessageId: string): string {
  const hex = createHash('sha256').update(`${kind}:${waMessageId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

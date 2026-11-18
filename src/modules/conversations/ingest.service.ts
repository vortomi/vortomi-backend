import { messages } from '../../db/schema/index.ts'
import { noteMedia } from '../chat-media/media-intake.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../whatsapp/events.ts'
import { touchConversation, upsertContact, upsertConversation } from './conversation-upsert.ts'

export interface InboundRecord {
  /** False when Meta delivered this message before: nothing else must run. */
  isNew: boolean
  contactId: string
  conversationId: string
}

/**
 * Persists an inbound customer message with its contact and conversation, inside
 * the company the event was routed to. Idempotent: replaying the same webhook
 * stores nothing new.
 */
export class IngestService {
  async recordInbound(scope: TenantScope, channelAccountId: string, event: InboundMessageEvent): Promise<InboundRecord> {
    const { tx, tenantId } = scope
    const contactId = await upsertContact(scope, channelAccountId, event.from, { displayName: event.profileName, lastInboundAt: event.timestamp })
    const conversationId = await upsertConversation(scope, contactId, { lastActivityAt: event.timestamp })

    // The unique (tenant_id, wa_message_id) is what makes duplicates harmless,
    // even with two workers racing on the same webhook (design document 8.2).
    const inserted = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId,
        waMessageId: event.waMessageId,
        direction: 'in',
        author: 'customer',
        type: event.type,
        body: event.body,
        waMediaId: event.waMediaId,
        waTimestamp: event.timestamp,
      })
      .onConflictDoNothing({ target: [messages.tenantId, messages.waMessageId] })
      .returning({ id: messages.id })

    const isNew = inserted.length > 0
    // Only a NEW message reopens a resolved conversation (the customer is waiting
    // again) and moves it up the inbox; a replayed webhook changes nothing.
    if (isNew) {
      await touchConversation(scope, conversationId, event.timestamp, true)
      await noteMedia(scope, [{ messageId: inserted[0]!.id, content: event }])
    }
    return { isNew, contactId, conversationId }
  }
}

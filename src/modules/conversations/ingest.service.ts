import { and, eq, sql } from 'drizzle-orm'
import { contacts, conversations, messages } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../whatsapp/events.ts'

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

    // greatest() keeps the newest timestamp when webhooks arrive out of order.
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, channelAccountId, waId: event.from, displayName: event.profileName, lastInboundAt: event.timestamp })
      .onConflictDoUpdate({
        target: [contacts.tenantId, contacts.channelAccountId, contacts.waId],
        set: {
          displayName: sql`coalesce(excluded.display_name, ${contacts.displayName})`,
          lastInboundAt: sql`greatest(${contacts.lastInboundAt}, excluded.last_inbound_at)`,
        },
      })
      .returning({ id: contacts.id })
    if (!contact) throw new Error('Contact upsert returned no row')

    // The no-op update only makes RETURNING give back an existing conversation.
    const [conversation] = await tx
      .insert(conversations)
      .values({ tenantId, contactId: contact.id, lastActivityAt: event.timestamp })
      .onConflictDoUpdate({
        target: [conversations.tenantId, conversations.contactId],
        set: { contactId: sql`excluded.contact_id` },
      })
      .returning({ id: conversations.id })
    if (!conversation) throw new Error('Conversation upsert returned no row')

    // The unique (tenant_id, wa_message_id) is what makes duplicates harmless,
    // even with two workers racing on the same webhook (design document 8.2).
    const inserted = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: conversation.id,
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
    if (isNew) {
      // Only a NEW message reopens a resolved conversation (the customer is waiting
      // again) and moves it up the inbox; a replayed webhook changes nothing.
      await tx
        .update(conversations)
        // A Date inside raw sql`` is not typed by a column: postgres-js would send its local
        // text form ("... hora de Venezuela"), which Postgres rejects. ISO plus an explicit cast.
        .set({ status: 'open', lastActivityAt: sql`greatest(${conversations.lastActivityAt}, ${event.timestamp.toISOString()}::timestamptz)` })
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)))
    }
    return { isNew, contactId: contact.id, conversationId: conversation.id }
  }
}

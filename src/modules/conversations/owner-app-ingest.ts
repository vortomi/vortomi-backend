import { and, eq, sql } from 'drizzle-orm'
import { contacts, messages } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { ContactSyncEvent, HistoryChunkEvent, HistoryMediaEvent, OwnerEchoEvent } from '../whatsapp/events.ts'
import { noteMedia } from '../chat-media/media-intake.ts'
import { pauseAgent } from './agent-handoff.ts'
import { touchConversation, upsertContact, upsertConversation } from './conversation-upsert.ts'

/**
 * What the owner does on the WhatsApp Business app of a coexistence number, stored in Vortomi so
 * the conversation is complete. Nothing here answers anyone: these are records, never triggers.
 * Every write is idempotent (unique wa_message_id, contact upserts): Meta may send a chunk twice.
 * The only effect beyond records: a live message of the owner pauses the agent in that conversation.
 */
export class OwnerAppIngest {
  /** The owner wrote to a customer from the phone. True when it is new (not a repeated webhook). */
  async recordEcho(scope: TenantScope, channelAccountId: string, event: OwnerEchoEvent): Promise<{ isNew: boolean; conversationId: string }> {
    const contactId = await upsertContact(scope, channelAccountId, event.to)
    // A conversation the owner starts from the phone is being handled there: not a new one for the team.
    const conversationId = await upsertConversation(scope, contactId, { lastActivityAt: event.timestamp, status: 'resolved', lastReadAt: event.timestamp })
    const inserted = await scope.tx
      .insert(messages)
      .values({
        tenantId: scope.tenantId,
        conversationId,
        waMessageId: event.waMessageId,
        direction: 'out',
        author: 'owner_app',
        type: event.type,
        body: event.body,
        waMediaId: event.waMediaId,
        waTimestamp: event.timestamp,
      })
      .onConflictDoNothing({ target: [messages.tenantId, messages.waMessageId] })
      .returning({ id: messages.id })
    const isNew = inserted.length > 0
    if (isNew) {
      await touchConversation(scope, conversationId, event.timestamp)
      // The owner is answering: the agent leaves this conversation to them for a while.
      await pauseAgent(scope, conversationId, event.timestamp, null)
      await noteMedia(scope, [{ messageId: inserted[0]!.id, content: event }])
    }
    return { isNew, conversationId }
  }

  /**
   * Past chats of the owner's app. Each message keeps its real time (created_at = when it was
   * written), so it falls in its place in the conversation and never counts as unread; imported
   * conversations start resolved, so months of chats do not flood the inbox. Returns how many
   * messages were new.
   */
  async recordHistory(scope: TenantScope, channelAccountId: string, event: HistoryChunkEvent): Promise<number> {
    let stored = 0
    for (const thread of event.threads) {
      const times = thread.messages.map((m) => m.timestamp.getTime())
      const latest = new Date(Math.max(...times))
      const customerTimes = thread.messages.filter((m) => !m.fromBusiness).map((m) => m.timestamp.getTime())
      const lastInboundAt = customerTimes.length ? new Date(Math.max(...customerTimes)) : null

      const contactId = await upsertContact(scope, channelAccountId, thread.waId, { lastInboundAt })
      const conversationId = await upsertConversation(scope, contactId, { lastActivityAt: latest, status: 'resolved', lastReadAt: latest })
      const inserted = await scope.tx
        .insert(messages)
        .values(
          thread.messages.map((m) => ({
            tenantId: scope.tenantId,
            conversationId,
            waMessageId: m.waMessageId,
            direction: m.fromBusiness ? ('out' as const) : ('in' as const),
            author: m.fromBusiness ? ('owner_app' as const) : ('customer' as const),
            type: m.type,
            body: m.body,
            waMediaId: m.waMediaId,
            waTimestamp: m.timestamp,
            createdAt: m.timestamp,
          })),
        )
        .onConflictDoNothing({ target: [messages.tenantId, messages.waMessageId] })
        .returning({ id: messages.id, waMessageId: messages.waMessageId })
      stored += inserted.length
      if (inserted.length) await touchConversation(scope, conversationId, latest)
      const byWaId = new Map(thread.messages.map((m) => [m.waMessageId, m]))
      await noteMedia(scope, inserted.flatMap((row) => {
        const content = byWaId.get(row.waMessageId!)
        return content ? [{ messageId: row.id, content }] : []
      }))
    }
    return stored
  }

  /**
   * The media of the history (last 14 days). Its placeholder, if already stored, becomes the photo,
   * audio or document it was, with its caption; a message that already has its media is left alone.
   * When the file comes first, it is stored as the history would have stored it, and the placeholder
   * arriving later changes nothing. Returns how many messages got their media.
   */
  async recordHistoryMedia(scope: TenantScope, channelAccountId: string, event: HistoryMediaEvent): Promise<number> {
    let filled = 0
    for (const item of event.items) {
      const placeholder = await scope.tx
        .update(messages)
        .set({ type: item.type, body: item.body, waMediaId: item.waMediaId })
        .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.waMessageId, item.waMessageId), eq(messages.type, 'unsupported')))
        .returning({ id: messages.id })
      if (placeholder.length) {
        await noteMedia(scope, [{ messageId: placeholder[0]!.id, content: item }])
        filled++
        continue
      }
      // Without the customer it went to there is no conversation to put it in: only a placeholder could take it.
      if (!item.customerWaId) continue
      const stored = await this.recordHistory(scope, channelAccountId, {
        kind: 'history_chunk',
        phoneNumberId: event.phoneNumberId,
        phase: 0,
        chunkOrder: 0,
        progress: 0,
        threads: [{ waId: item.customerWaId, messages: [item] }],
      })
      filled += stored
    }
    return filled
  }

  /**
   * The names the owner saved in the app become the contact's name, only where the team has not
   * named it: a name typed in Vortomi always wins. A contact deleted in the app is kept here (its
   * conversations and orders stay); only new contacts are created, never conversations.
   */
  async applyContacts(scope: TenantScope, channelAccountId: string, event: ContactSyncEvent): Promise<number> {
    // One row per number (the last change wins): one INSERT cannot touch the same row twice.
    const byWaId = new Map<string, string | null>()
    for (const c of [...event.contacts].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      if (c.action === 'add') byWaId.set(c.waId, c.fullName)
      else byWaId.delete(c.waId)
    }
    if (!byWaId.size) return 0
    const rows = await scope.tx
      .insert(contacts)
      .values([...byWaId].map(([waId, name]) => ({ tenantId: scope.tenantId, channelAccountId, waId, name })))
      .onConflictDoUpdate({
        target: [contacts.tenantId, contacts.channelAccountId, contacts.waId],
        set: { name: sql`coalesce(${contacts.name}, excluded.name)` },
      })
      .returning({ id: contacts.id })
    return rows.length
  }
}

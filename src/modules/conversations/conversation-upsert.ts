import { and, eq, sql } from 'drizzle-orm'
import type { ConversationStatus } from '../../db/schema/enums.ts'
import { contacts, conversations } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'

/**
 * The customer of a number, created on first sight. A profile name only replaces the stored one when
 * WhatsApp sends one; the last inbound time only moves forward (webhooks arrive out of order).
 */
export async function upsertContact(
  scope: TenantScope,
  channelAccountId: string,
  waId: string,
  seen: { displayName?: string | null; lastInboundAt?: Date | null } = {},
): Promise<string> {
  const { tx, tenantId } = scope
  const [contact] = await tx
    .insert(contacts)
    .values({ tenantId, channelAccountId, waId, displayName: seen.displayName ?? null, lastInboundAt: seen.lastInboundAt ?? null })
    .onConflictDoUpdate({
      target: [contacts.tenantId, contacts.channelAccountId, contacts.waId],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${contacts.displayName})`,
        // greatest() ignores nulls: a message that is not the customer's leaves it as it was.
        lastInboundAt: sql`greatest(${contacts.lastInboundAt}, excluded.last_inbound_at)`,
      },
    })
    .returning({ id: contacts.id })
  if (!contact) throw new Error('Contact upsert returned no row')
  return contact.id
}

/**
 * The contact's conversation (one per contact). `whenNew` only applies when it is created: an
 * existing conversation keeps its state.
 */
export async function upsertConversation(
  scope: TenantScope,
  contactId: string,
  whenNew: { lastActivityAt: Date; status?: ConversationStatus; lastReadAt?: Date | null },
): Promise<string> {
  const { tx, tenantId } = scope
  // The no-op update only makes RETURNING give back an existing conversation.
  const [conversation] = await tx
    .insert(conversations)
    .values({ tenantId, contactId, lastActivityAt: whenNew.lastActivityAt, status: whenNew.status ?? 'open', lastReadAt: whenNew.lastReadAt ?? null })
    .onConflictDoUpdate({ target: [conversations.tenantId, conversations.contactId], set: { contactId: sql`excluded.contact_id` } })
    .returning({ id: conversations.id })
  if (!conversation) throw new Error('Conversation upsert returned no row')
  return conversation.id
}

/** Moves the conversation up the inbox to `at`, never back (messages arrive out of order). */
export async function touchConversation(scope: TenantScope, conversationId: string, at: Date, reopen = false): Promise<void> {
  await scope.tx
    .update(conversations)
    // A Date inside raw sql`` is not typed by a column: postgres-js would send its local
    // text form ("... hora de Venezuela"), which Postgres rejects. ISO plus an explicit cast.
    .set({
      ...(reopen ? { status: 'open' as const } : {}),
      lastActivityAt: sql`greatest(${conversations.lastActivityAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

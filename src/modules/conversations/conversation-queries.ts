import { type SQL, and, desc, eq, exists, ilike, isNull, lt, or, sql } from 'drizzle-orm'
import { contactTags, contacts, conversations, messageDeliveryStatus, messages } from '../../db/schema/index.ts'
import type { DeliveryStatus, MessageType } from '../../db/schema/enums.ts'
import { type Cursor, encodeCursor, likePattern } from '../../shared/pagination.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { visibleConversations } from './visibility.ts'

export type DeliveryState = DeliveryStatus | 'pending'

export type InboxView = 'mine' | 'unassigned' | 'all'

export interface ConversationFilters {
  view: InboxView
  channelAccountId?: string | undefined
  tagId?: string | undefined
  search?: string | undefined
  cursor?: Cursor | undefined
  limit: number
}

export interface LastMessage {
  direction: 'in' | 'out'
  type: MessageType
  body: string | null
  createdAt: string
}

// Correlated subqueries, both served by messages_conversation_created_idx.
const unreadCount = sql<number>`(
  select count(*)::int from ${messages} m
  where m.tenant_id = ${conversations.tenantId} and m.conversation_id = ${conversations.id} and m.direction = 'in'
    and (${conversations.lastReadAt} is null or m.created_at > ${conversations.lastReadAt}))`

const lastMessage = sql<LastMessage | null>`(
  select json_build_object('direction', m.direction, 'type', m.type, 'body', m.body, 'createdAt', m.created_at)
  from ${messages} m
  where m.tenant_id = ${conversations.tenantId} and m.conversation_id = ${conversations.id}
  order by m.created_at desc, m.id desc limit 1)`

const columns = {
  id: conversations.id,
  status: conversations.status,
  assignedUserId: conversations.assignedUserId,
  lastActivityAt: conversations.lastActivityAt,
  channelAccountId: contacts.channelAccountId,
  contact: { id: contacts.id, waId: contacts.waId, name: contacts.name, displayName: contacts.displayName },
  // The 24 h window Meta allows free-form replies in, opened by the customer's last message.
  serviceWindowExpiresAt: sql<Date | null>`${contacts.lastInboundAt} + interval '24 hours'`.mapWith(contacts.lastInboundAt),
  unreadCount,
  lastMessage,
  cursorAt: sql<string>`${conversations.lastActivityAt}::text`,
}

/** Read side of the inbox. Every query is limited to what the member may see (visibility.ts). */
export class ConversationQueries {
  async list(scope: MemberScope, filters: ConversationFilters) {
    const { tx, member } = scope
    const conditions: (SQL | undefined)[] = [visibleConversations(member), viewFilter(filters.view, member.userId)]
    if (filters.channelAccountId) conditions.push(eq(contacts.channelAccountId, filters.channelAccountId))
    if (filters.tagId) {
      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(contactTags)
            .where(and(eq(contactTags.tenantId, conversations.tenantId), eq(contactTags.contactId, contacts.id), eq(contactTags.tagId, filters.tagId))),
        ),
      )
    }
    if (filters.search) {
      const pattern = likePattern(filters.search)
      conditions.push(or(ilike(contacts.name, pattern), ilike(contacts.displayName, pattern), ilike(contacts.waId, pattern)))
    }
    if (filters.cursor) {
      conditions.push(sql`(${conversations.lastActivityAt}, ${conversations.id}) < (${filters.cursor.at}::timestamptz, ${filters.cursor.id}::uuid)`)
    }

    const rows = await tx
      .select(columns)
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .where(and(...conditions))
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
      .limit(filters.limit + 1)

    const page = rows.slice(0, filters.limit)
    const last = page.at(-1)
    return {
      items: page.map(withoutCursor),
      nextCursor: rows.length > filters.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    }
  }

  /** One conversation, or null when it does not exist OR the member may not see it (same answer). */
  async get(scope: MemberScope, conversationId: string) {
    const { tx, member } = scope
    const [row] = await tx
      .select(columns)
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .where(and(eq(conversations.id, conversationId), visibleConversations(member)))
    return row ? withoutCursor(row) : null
  }

  /** Newest first, `limit` at a time; `beforeId` continues an older page. Caller checks visibility. */
  async messages(scope: MemberScope, conversationId: string, limit: number, beforeId?: number) {
    const rows = await scope.tx
      .select({
        id: messages.id,
        direction: messages.direction,
        author: messages.author,
        authorUserId: messages.authorUserId,
        type: messages.type,
        body: messages.body,
        templateId: messages.templateId,
        createdAt: messages.createdAt,
        clientMessageId: messages.clientMessageId,
        // Furthest status Meta reported; before that, failed (never reached Meta) or pending.
        status: sql<DeliveryState | null>`case
          when ${messages.direction} = 'in' then null
          when ${messageDeliveryStatus.status} is not null then ${messageDeliveryStatus.status}
          when ${messages.sendError} is not null then 'failed'
          else 'pending' end`,
      })
      .from(messages)
      .leftJoin(
        messageDeliveryStatus,
        and(eq(messageDeliveryStatus.tenantId, messages.tenantId), eq(messageDeliveryStatus.waMessageId, messages.waMessageId)),
      )
      .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.conversationId, conversationId), beforeId ? lt(messages.id, beforeId) : undefined))
      .orderBy(desc(messages.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    return { items: page, nextBeforeId: rows.length > limit ? (page.at(-1)?.id ?? null) : null }
  }
}

function viewFilter(view: InboxView, userId: string): SQL | undefined {
  switch (view) {
    case 'mine':
      return and(eq(conversations.status, 'open'), eq(conversations.assignedUserId, userId))
    case 'unassigned':
      return and(eq(conversations.status, 'open'), isNull(conversations.assignedUserId))
    case 'all':
      return undefined
  }
}

function withoutCursor<T extends { cursorAt: string }>({ cursorAt: _cursorAt, ...row }: T): Omit<T, 'cursorAt'> {
  return row
}

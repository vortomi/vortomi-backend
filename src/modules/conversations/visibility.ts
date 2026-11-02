import { type SQL, sql } from 'drizzle-orm'
import { contacts, conversationAssignees, conversations } from '../../db/schema/index.ts'
import type { Member } from '../access/member-scope.ts'

// What a person may see inside their own company (the company boundary itself is RLS).
// One definition, used by every query that returns conversations or contacts, so the list,
// the detail, the messages, the notes and the contact can never disagree.
//
//   admin -> everything in the company, and hands conversations out
//   agent -> only the conversations assigned to them (one conversation may have several people)

const assignees = sql`select 1 from ${conversationAssignees} a
  where a.tenant_id = ${conversations.tenantId} and a.conversation_id = ${conversations.id}`

/** Conversations this person attends. */
export const assignedTo = (userId: string): SQL => sql`exists (${assignees} and a.user_id = ${userId})`

/** Conversations nobody attends. */
export const unassigned: SQL = sql`not exists (${assignees})`

/** Who attends each conversation, first assigned first. */
export const assigneeIds = sql<string[]>`coalesce((
  select json_agg(a.user_id order by a.assigned_at, a.user_id) from ${conversationAssignees} a
  where a.tenant_id = ${conversations.tenantId} and a.conversation_id = ${conversations.id}), '[]'::json)`

/** Filter on conversations. Undefined = no restriction. */
export function visibleConversations(member: Member): SQL | undefined {
  return member.role === 'admin' ? undefined : assignedTo(member.userId)
}

/** Filter on contacts: an agent sees the customers of the conversations assigned to them. */
export function visibleContacts(member: Member): SQL | undefined {
  if (member.role === 'admin') return undefined
  return sql`exists (select 1 from ${conversations} c join ${conversationAssignees} a
    on a.tenant_id = c.tenant_id and a.conversation_id = c.id
    where c.tenant_id = ${contacts.tenantId} and c.contact_id = ${contacts.id} and a.user_id = ${member.userId})`
}

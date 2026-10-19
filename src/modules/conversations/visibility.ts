import { type SQL, and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { contacts, conversations } from '../../db/schema/index.ts'
import type { Member } from '../access/member-scope.ts'

// What a person may see inside their own company (the company boundary itself is RLS).
// One definition, used by every query that returns conversations or contacts, so the
// list, the detail, the messages and the notes can never disagree.
//
//   admin                      -> everything in the company
//   agent                      -> only the numbers assigned to them
//   agent without canSeeOthers -> of those, unassigned conversations and their own

/** Filter on contacts: the numbers the member attends. Undefined = no restriction. */
export function visibleContacts(member: Member): SQL | undefined {
  if (member.role === 'admin') return undefined
  if (member.channelAccountIds.length === 0) return sql`false`
  return inArray(contacts.channelAccountId, [...member.channelAccountIds])
}

/** Filter on conversations joined with their contact. */
export function visibleConversations(member: Member): SQL | undefined {
  const onTheirNumbers = visibleContacts(member)
  if (member.role === 'admin' || member.canSeeOthers) return onTheirNumbers
  return and(onTheirNumbers, or(isNull(conversations.assignedUserId), eq(conversations.assignedUserId, member.userId)))
}

/** Whether a member may be put in charge of a conversation on that number. */
export function canAttend(member: Pick<Member, 'role' | 'channelAccountIds'>, channelAccountId: string): boolean {
  return member.role === 'admin' || member.channelAccountIds.includes(channelAccountId)
}

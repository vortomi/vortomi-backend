import { and, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { ConversationStatus } from '../../db/schema/enums.ts'
import { conversations, notes } from '../../db/schema/index.ts'
import { type MemberScope, findActiveMember } from '../access/member-scope.ts'
import type { ConversationQueries } from './conversation-queries.ts'
import { canAttend } from './visibility.ts'

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Conversation not found or not visible')
    this.name = 'ConversationNotFoundError'
  }
}

export class AssigneeCannotAttendError extends Error {
  constructor() {
    super('Assignee is not an active member who attends this number')
    this.name = 'AssigneeCannotAttendError'
  }
}

export class MentionNotMemberError extends Error {
  constructor() {
    super('Mentioned person is not an active member of this company')
    this.name = 'MentionNotMemberError'
  }
}

/**
 * Write side of the inbox. Every command first loads the conversation through the
 * same visibility rule as the list: what a member cannot see, they cannot change.
 */
export class ConversationCommands {
  constructor(private readonly queries: ConversationQueries) {}

  private async visible(scope: MemberScope, conversationId: string) {
    const conversation = await this.queries.get(scope, conversationId)
    if (!conversation) throw new ConversationNotFoundError()
    return conversation
  }

  private update(scope: MemberScope, conversationId: string, values: PgUpdateSetSource<typeof conversations>) {
    return scope.tx
      .update(conversations)
      .set(values)
      .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
  }

  /** Read for the whole team: everything received until now is no longer unread. */
  async markRead(scope: MemberScope, conversationId: string): Promise<void> {
    await this.visible(scope, conversationId)
    await this.update(scope, conversationId, { lastReadAt: sql`now()` })
  }

  async setStatus(scope: MemberScope, conversationId: string, status: ConversationStatus): Promise<void> {
    await this.visible(scope, conversationId)
    await this.update(scope, conversationId, { status })
  }

  /**
   * Hands the conversation to someone (or to nobody). The assignee must be an active
   * member who attends that number; the composite foreign key already guarantees
   * they are of this company.
   */
  async assign(scope: MemberScope, conversationId: string, assigneeId: string | null): Promise<void> {
    const conversation = await this.visible(scope, conversationId)
    if (assigneeId) {
      const assignee = await findActiveMember(scope, assigneeId)
      if (!assignee || !canAttend(assignee, conversation.channelAccountId)) throw new AssigneeCannotAttendError()
    }
    await this.update(scope, conversationId, { assignedUserId: assigneeId })
  }

  async notes(scope: MemberScope, conversationId: string) {
    await this.visible(scope, conversationId)
    return scope.tx
      .select({ id: notes.id, authorUserId: notes.authorUserId, mentionUserId: notes.mentionUserId, body: notes.body, createdAt: notes.createdAt })
      .from(notes)
      .where(and(eq(notes.tenantId, scope.tenantId), eq(notes.conversationId, conversationId)))
      .orderBy(notes.createdAt)
  }

  async addNote(scope: MemberScope, conversationId: string, body: string, mentionUserId: string | null) {
    await this.visible(scope, conversationId)
    if (mentionUserId && !(await findActiveMember(scope, mentionUserId))) throw new MentionNotMemberError()
    const [note] = await scope.tx
      .insert(notes)
      .values({ tenantId: scope.tenantId, conversationId, authorUserId: scope.member.userId, mentionUserId, body })
      .returning({ id: notes.id, createdAt: notes.createdAt })
    return note!
  }
}

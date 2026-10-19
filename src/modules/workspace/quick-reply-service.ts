import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { quickReplies } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

export class QuickReplyNotFoundError extends Error {
  constructor() {
    super('Quick reply not found')
    this.name = 'QuickReplyNotFoundError'
  }
}

export const quickReplyInput = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,30}$/),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
})
export type QuickReplyInput = z.infer<typeof quickReplyInput>

const columns = { id: quickReplies.id, shortcut: quickReplies.shortcut, title: quickReplies.title, body: quickReplies.body }

/** Canned answers typed after "/" in the composer. Anyone reads them; admins edit (routes). */
export class QuickReplyService {
  list(scope: MemberScope) {
    return scope.tx.select(columns).from(quickReplies).where(eq(quickReplies.tenantId, scope.tenantId)).orderBy(asc(quickReplies.shortcut))
  }

  async create(scope: MemberScope, input: QuickReplyInput) {
    const [row] = await scope.tx
      .insert(quickReplies)
      .values({ tenantId: scope.tenantId, ...input })
      .returning(columns)
    return row!
  }

  async update(scope: MemberScope, id: string, input: QuickReplyInput) {
    const [row] = await scope.tx
      .update(quickReplies)
      .set(input)
      .where(and(eq(quickReplies.tenantId, scope.tenantId), eq(quickReplies.id, id)))
      .returning(columns)
    if (!row) throw new QuickReplyNotFoundError()
    return row
  }

  async remove(scope: MemberScope, id: string) {
    const deleted = await scope.tx
      .delete(quickReplies)
      .where(and(eq(quickReplies.tenantId, scope.tenantId), eq(quickReplies.id, id)))
      .returning({ id: quickReplies.id })
    if (!deleted.length) throw new QuickReplyNotFoundError()
  }
}

import { and, asc, eq } from 'drizzle-orm'
import type { TagTone } from '../../db/schema/enums.ts'
import { tags } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

export class TagNotFoundError extends Error {
  constructor() {
    super('Tag not found')
    this.name = 'TagNotFoundError'
  }
}

export interface TagInput {
  name: string
  tone: TagTone
}

/** The company's tag list. Anyone reads it; the routes only let admins change it. */
export class TagService {
  list(scope: MemberScope) {
    return scope.tx
      .select({ id: tags.id, name: tags.name, tone: tags.tone })
      .from(tags)
      .where(eq(tags.tenantId, scope.tenantId))
      .orderBy(asc(tags.name))
  }

  /** A duplicate name (any case) fails on tags_tenant_name_key: the database decides, not a prior check. */
  async create(scope: MemberScope, input: TagInput) {
    const [tag] = await scope.tx
      .insert(tags)
      .values({ tenantId: scope.tenantId, name: input.name, tone: input.tone })
      .returning({ id: tags.id, name: tags.name, tone: tags.tone })
    return tag!
  }

  async update(scope: MemberScope, tagId: string, input: TagInput) {
    const [tag] = await scope.tx
      .update(tags)
      .set(input)
      .where(and(eq(tags.tenantId, scope.tenantId), eq(tags.id, tagId)))
      .returning({ id: tags.id, name: tags.name, tone: tags.tone })
    if (!tag) throw new TagNotFoundError()
    return tag
  }

  /** Removing a tag also removes it from every contact (cascade). */
  async remove(scope: MemberScope, tagId: string) {
    const deleted = await scope.tx
      .delete(tags)
      .where(and(eq(tags.tenantId, scope.tenantId), eq(tags.id, tagId)))
      .returning({ id: tags.id })
    if (!deleted.length) throw new TagNotFoundError()
  }
}

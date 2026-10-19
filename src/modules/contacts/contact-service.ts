import { type SQL, and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { contactTags, contacts, tags } from '../../db/schema/index.ts'
import { type Cursor, encodeCursor, likePattern } from '../../shared/pagination.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { visibleContacts } from '../conversations/visibility.ts'

export class ContactNotFoundError extends Error {
  constructor() {
    super('Contact not found or not visible')
    this.name = 'ContactNotFoundError'
  }
}

export class UnknownTagError extends Error {
  constructor() {
    super('One or more tags do not exist in this company')
    this.name = 'UnknownTagError'
  }
}

export interface ContactFilters {
  search?: string | undefined
  cursor?: Cursor | undefined
  limit: number
}

const columns = {
  id: contacts.id,
  channelAccountId: contacts.channelAccountId,
  waId: contacts.waId,
  name: contacts.name,
  displayName: contacts.displayName,
  stageId: contacts.stageId,
  quoteCents: contacts.quoteCents,
  lastInboundAt: contacts.lastInboundAt,
  createdAt: contacts.createdAt,
  tagIds: sql<string[]>`coalesce((
    select array_agg(ct.tag_id order by ct.tag_id) from ${contactTags} ct
    where ct.tenant_id = ${contacts.tenantId} and ct.contact_id = ${contacts.id}), '{}')`,
  cursorAt: sql<string>`${contacts.createdAt}::text`,
}

/** Contacts of the company, limited to the numbers the member attends (visibility.ts). */
export class ContactService {
  async list(scope: MemberScope, filters: ContactFilters) {
    const conditions: (SQL | undefined)[] = [eq(contacts.tenantId, scope.tenantId), visibleContacts(scope.member)]
    if (filters.search) {
      const pattern = likePattern(filters.search)
      conditions.push(or(ilike(contacts.name, pattern), ilike(contacts.displayName, pattern), ilike(contacts.waId, pattern)))
    }
    if (filters.cursor) {
      conditions.push(sql`(${contacts.createdAt}, ${contacts.id}) < (${filters.cursor.at}::timestamptz, ${filters.cursor.id}::uuid)`)
    }
    const rows = await scope.tx
      .select(columns)
      .from(contacts)
      .where(and(...conditions))
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(filters.limit + 1)
    const page = rows.slice(0, filters.limit)
    const last = page.at(-1)
    return {
      items: page.map(({ cursorAt: _cursorAt, ...row }) => row),
      nextCursor: rows.length > filters.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    }
  }

  async get(scope: MemberScope, contactId: string) {
    const [row] = await scope.tx
      .select(columns)
      .from(contacts)
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId), visibleContacts(scope.member)))
    if (!row) throw new ContactNotFoundError()
    const { cursorAt: _cursorAt, ...contact } = row
    return contact
  }

  /** The name the team uses; null goes back to the WhatsApp profile name. */
  async rename(scope: MemberScope, contactId: string, name: string | null) {
    await this.get(scope, contactId)
    await scope.tx
      .update(contacts)
      .set({ name })
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId)))
  }

  /** Replaces the contact's tags with exactly `tagIds` (all of this company). */
  async setTags(scope: MemberScope, contactId: string, tagIds: string[]) {
    await this.get(scope, contactId)
    const unique = [...new Set(tagIds)]
    if (unique.length) {
      const found = await scope.tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.tenantId, scope.tenantId), inArray(tags.id, unique)))
      if (found.length !== unique.length) throw new UnknownTagError()
    }
    await scope.tx.delete(contactTags).where(and(eq(contactTags.tenantId, scope.tenantId), eq(contactTags.contactId, contactId)))
    if (unique.length) {
      await scope.tx.insert(contactTags).values(unique.map((tagId) => ({ tenantId: scope.tenantId, contactId, tagId })))
    }
  }
}

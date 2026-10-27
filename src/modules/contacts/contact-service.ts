import { type SQL, and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { contactTags, contacts, memberships, pipelineStages, tags } from '../../db/schema/index.ts'
import { type Cursor, encodeCursor, likePattern } from '../../shared/pagination.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { CustomFieldService } from '../custom-fields/custom-field-service.ts'
import { checkValues, customValuesInput } from '../custom-fields/custom-values.ts'
import { canAttend, visibleContacts } from '../conversations/visibility.ts'
import { StageNotFoundError } from '../workspace/pipeline-service.ts'

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

/** The person does not attend that number, so they cannot add contacts to it. */
export class ChannelNotAttendedError extends Error {
  constructor() {
    super('The member does not attend that number')
    this.name = 'ChannelNotAttendedError'
  }
}

/** The person put in charge is not an active member of the company. */
export class OwnerNotMemberError extends Error {
  constructor() {
    super('The owner must be an active member of the company')
    this.name = 'OwnerNotMemberError'
  }
}

/** Facts the team keeps about a customer: up to 30, each key once. */
export const attributesInput = z
  .array(
    z.object({
      key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
      label: z.string().trim().min(1).max(40),
      value: z.string().trim().max(500),
    }),
  )
  .max(30)
  .refine((list) => new Set(list.map((a) => a.key)).size === list.length, 'each key once')

/** "+58 412-555-0101" -> "584125550101": WhatsApp ids are the international number, digits only. */
export const waIdInput = z
  .string()
  .transform((raw) => raw.replace(/\D/g, ''))
  .refine((digits) => digits.length >= 8 && digits.length <= 15, 'Phone: 8 to 15 digits with country code')

export const contactInput = z.object({
  channelAccountId: z.uuid(),
  waId: waIdInput,
  name: z.string().trim().min(1).max(80).nullable().default(null),
  stageId: z.uuid().nullable().default(null),
  tagIds: z.array(z.uuid()).max(20).default([]),
  ownerUserId: z.uuid().nullable().default(null),
  attributes: attributesInput.default([]),
  // The company's own data about the customer ("Vehículo", "Zona"), checked against its fields.
  customValues: customValuesInput.default({}),
})
export type ContactInput = z.infer<typeof contactInput>

export const importInput = z.object({
  channelAccountId: z.uuid(),
  rows: z
    .array(z.object({ waId: waIdInput, name: z.string().trim().min(1).max(80).nullable().default(null), tagIds: z.array(z.uuid()).max(20).default([]) }))
    .min(1)
    .max(1000),
})
export type ImportInput = z.infer<typeof importInput>

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
  ownerUserId: contacts.ownerUserId,
  attributes: contacts.attributes,
  customValues: contacts.customValues,
  lastInboundAt: contacts.lastInboundAt,
  createdAt: contacts.createdAt,
  tagIds: sql<string[]>`coalesce((
    select array_agg(ct.tag_id order by ct.tag_id) from ${contactTags} ct
    where ct.tenant_id = ${contacts.tenantId} and ct.contact_id = ${contacts.id}), '{}')`,
  cursorAt: sql<string>`${contacts.createdAt}::text`,
}

/** Contacts of the company, limited to the numbers the member attends (visibility.ts). */
export class ContactService {
  constructor(private readonly customFields: CustomFieldService) {}

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

  /**
   * A contact typed by hand, before they ever write: on a number the person attends. The same
   * phone on the same number twice fails on its unique key (409 contact_exists).
   */
  async create(scope: MemberScope, input: ContactInput) {
    if (!canAttend(scope.member, input.channelAccountId)) throw new ChannelNotAttendedError()
    if (input.stageId) {
      const [stage] = await scope.tx
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.tenantId, scope.tenantId), eq(pipelineStages.id, input.stageId)))
      if (!stage) throw new StageNotFoundError()
    }
    const tagIds = await this.knownTags(scope, input.tagIds)
    if (input.ownerUserId) await this.activeMember(scope, input.ownerUserId)
    const customValues = checkValues(await this.customFields.definitions(scope, 'contact'), input.customValues)
    const [row] = await scope.tx
      .insert(contacts)
      .values({
        tenantId: scope.tenantId,
        channelAccountId: input.channelAccountId,
        waId: input.waId,
        name: input.name,
        stageId: input.stageId,
        ownerUserId: input.ownerUserId,
        attributes: input.attributes,
        customValues,
      })
      .returning({ id: contacts.id })
    if (tagIds.length) await scope.tx.insert(contactTags).values(tagIds.map((tagId) => ({ tenantId: scope.tenantId, contactId: row!.id, tagId })))
    return this.get(scope, row!.id)
  }

  /**
   * A list from a file, in one go: new phones become contacts; known ones keep their name (or
   * get it, if they had none) and gain the tags. All or nothing: one bad row stops the import.
   */
  async import(scope: MemberScope, input: ImportInput): Promise<{ created: number; updated: number }> {
    if (!canAttend(scope.member, input.channelAccountId)) throw new ChannelNotAttendedError()
    await this.knownTags(scope, input.rows.flatMap((r) => r.tagIds))
    // The last row of a repeated phone wins, like a spreadsheet.
    const rows = [...new Map(input.rows.map((r) => [r.waId, r])).values()]
    let created = 0
    for (const row of rows) {
      const [saved] = await scope.tx
        .insert(contacts)
        .values({ tenantId: scope.tenantId, channelAccountId: input.channelAccountId, waId: row.waId, name: row.name })
        .onConflictDoUpdate({
          target: [contacts.tenantId, contacts.channelAccountId, contacts.waId],
          set: { name: sql`coalesce(${contacts.name}, excluded.name)` },
        })
        // xmax is 0 only for a row this statement inserted (Postgres' way to tell insert from update).
        .returning({ id: contacts.id, inserted: sql<boolean>`(xmax = 0)` })
      if (saved!.inserted) created++
      const tagIds = [...new Set(row.tagIds)]
      if (tagIds.length) {
        await scope.tx
          .insert(contactTags)
          .values(tagIds.map((tagId) => ({ tenantId: scope.tenantId, contactId: saved!.id, tagId })))
          .onConflictDoNothing()
      }
    }
    return { created, updated: rows.length - created }
  }

  /** Replaces the contact's tags with exactly `tagIds` (all of this company). */
  async setTags(scope: MemberScope, contactId: string, tagIds: string[]) {
    await this.get(scope, contactId)
    const unique = await this.knownTags(scope, tagIds)
    await scope.tx.delete(contactTags).where(and(eq(contactTags.tenantId, scope.tenantId), eq(contactTags.contactId, contactId)))
    if (unique.length) {
      await scope.tx.insert(contactTags).values(unique.map((tagId) => ({ tenantId: scope.tenantId, contactId, tagId })))
    }
  }

  /** Who follows the customer up; null leaves it with nobody. Only active members of the company. */
  async setOwner(scope: MemberScope, contactId: string, ownerUserId: string | null) {
    await this.get(scope, contactId)
    if (ownerUserId) await this.activeMember(scope, ownerUserId)
    await scope.tx
      .update(contacts)
      .set({ ownerUserId })
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId)))
  }

  /** Replaces the contact's extra facts with exactly `attributes`. */
  async setAttributes(scope: MemberScope, contactId: string, attributes: z.infer<typeof attributesInput>) {
    await this.get(scope, contactId)
    await scope.tx
      .update(contacts)
      .set({ attributes })
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId)))
  }

  /** Replaces the contact's answers to the company's fields; required ones must be answered. */
  async setCustomValues(scope: MemberScope, contactId: string, input: Record<string, unknown>) {
    await this.get(scope, contactId)
    const customValues = checkValues(await this.customFields.definitions(scope, 'contact'), input)
    await scope.tx
      .update(contacts)
      .set({ customValues })
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId)))
  }

  /** The composite key already keeps the owner in this company; this also keeps them active. */
  private async activeMember(scope: MemberScope, userId: string): Promise<void> {
    const [member] = await scope.tx
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.userId, userId)))
    if (member?.status !== 'active') throw new OwnerNotMemberError()
  }

  /** The distinct tag ids, once checked they are all of this company. */
  private async knownTags(scope: MemberScope, tagIds: string[]): Promise<string[]> {
    const unique = [...new Set(tagIds)]
    if (!unique.length) return unique
    const found = await scope.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.tenantId, scope.tenantId), inArray(tags.id, unique)))
    if (found.length !== unique.length) throw new UnknownTagError()
    return unique
  }
}

import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, primaryKey, text, uniqueIndex, unique, uuid } from 'drizzle-orm/pg-core'
import { memberships } from './access.ts'
import { createdAtColumn, oneOf, tenantIdColumn, uuidIdColumn } from './columns.ts'
import { contacts, conversations } from './conversations.ts'
import { TAG_TONES } from './enums.ts'
import { tenants } from './tenancy.ts'

// What the team adds on top of WhatsApp: tags on contacts and internal notes.
// Same rule as everywhere else: composite (tenant_id, id) foreign keys only.

export const tags = pgTable(
  'tags',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    name: text('name').notNull(),
    tone: text('tone', { enum: TAG_TONES }).notNull().default('neutral'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('tags_tenant_id_id_key').on(t.tenantId, t.id),
    // "VIP" and "vip" are the same tag.
    uniqueIndex('tags_tenant_name_key').on(t.tenantId, sql`lower(${t.name})`),
    check('tags_tone_check', oneOf(t.tone, TAG_TONES)),
    check('tags_name_check', sql`length(trim(${t.name})) between 1 and 40`),
  ],
)

export const contactTags = pgTable(
  'contact_tags',
  {
    tenantId: tenantIdColumn(),
    contactId: uuid('contact_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'contact_tags_pkey', columns: [t.tenantId, t.contactId, t.tagId] }),
    foreignKey({ name: 'contact_tags_contact_fk', columns: [t.tenantId, t.contactId], foreignColumns: [contacts.tenantId, contacts.id] }).onDelete('cascade'),
    foreignKey({ name: 'contact_tags_tag_fk', columns: [t.tenantId, t.tagId], foreignColumns: [tags.tenantId, tags.id] }).onDelete('cascade'),
    index('contact_tags_tag_idx').on(t.tenantId, t.tagId),
  ],
)

/** Internal note on a conversation. The customer never sees it; it is never edited. */
export const notes = pgTable(
  'notes',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    conversationId: uuid('conversation_id').notNull(),
    authorUserId: uuid('author_user_id').notNull(),
    mentionUserId: uuid('mention_user_id'),
    body: text('body').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({ name: 'notes_conversation_fk', columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }),
    foreignKey({ name: 'notes_author_fk', columns: [t.tenantId, t.authorUserId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    foreignKey({ name: 'notes_mention_fk', columns: [t.tenantId, t.mentionUserId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index('notes_conversation_created_idx').on(t.tenantId, t.conversationId, t.createdAt),
    check('notes_body_check', sql`length(trim(${t.body})) between 1 and 4000`),
  ],
)

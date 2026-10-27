import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, pgView, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, serialIdColumn, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { CONVERSATION_STATUSES, DELIVERY_STATUSES, MESSAGE_AUTHORS, MESSAGE_DIRECTIONS, MESSAGE_TYPES } from './enums.ts'
import { memberships } from './access.ts'
import { channelAccounts, tenants } from './tenancy.ts'
import { messageTemplates } from './templates.ts'
import { pipelineStages } from './workspace.ts'

// Every foreign key between tenant rows is composite (tenant_id, id): the database
// itself makes it impossible to hang one company's row from another company's.

/** A customer as seen by ONE number of ONE company: the same phone on two numbers is two contacts. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    channelAccountId: uuid('channel_account_id').notNull(),
    // WhatsApp id (international phone number, digits only).
    waId: text('wa_id').notNull(),
    // Name WhatsApp reports (the customer profile); updated on every message.
    displayName: text('display_name'),
    // Name the team gives the contact; shown instead of display_name when set.
    name: text('name'),
    // Sales pipeline (v1: one open opportunity per contact, documentations/05).
    stageId: uuid('stage_id'),
    quoteCents: integer('quote_cents'),
    // The team member who follows this customer up; a member of the same company. Null = nobody.
    ownerUserId: uuid('owner_user_id'),
    // Facts the team keeps about the customer: [{ key, label, value }], validated by the API.
    attributes: jsonb('attributes').$type<ContactAttribute[]>().notNull().default(sql`'[]'::jsonb`),
    // Opens the 24 h customer service window.
    lastInboundAt: timestamptz('last_inbound_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('contacts_tenant_id_id_key').on(t.tenantId, t.id),
    unique('contacts_tenant_channel_wa_id_key').on(t.tenantId, t.channelAccountId, t.waId),
    foreignKey({
      name: 'contacts_channel_fk',
      columns: [t.tenantId, t.channelAccountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }),
    check('contacts_wa_id_check', sql`${t.waId} ~ '^[0-9]+$'`),
    foreignKey({ name: 'contacts_stage_fk', columns: [t.tenantId, t.stageId], foreignColumns: [pipelineStages.tenantId, pipelineStages.id] }),
    check('contacts_quote_check', sql`${t.quoteCents} is null or ${t.quoteCents} >= 0`),
    foreignKey({ name: 'contacts_owner_fk', columns: [t.tenantId, t.ownerUserId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    check('contacts_attributes_check', sql`jsonb_typeof(${t.attributes}) = 'array' and jsonb_array_length(${t.attributes}) <= 30`),
  ],
)

export interface ContactAttribute {
  /** Stable id of the field ("talla", "direccion"); unique within the contact. */
  key: string
  label: string
  value: string
}

/** One conversation per contact in v1 (documentations/05: one opportunity per contact). */
export const conversations = pgTable(
  'conversations',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    contactId: uuid('contact_id').notNull(),
    // A member of the same company (composite key below); null = unassigned.
    assignedUserId: uuid('assigned_user_id'),
    status: text('status', { enum: CONVERSATION_STATUSES }).notNull().default('open'),
    lastActivityAt: timestamptz('last_activity_at').notNull().defaultNow(),
    // Shared by the team: inbound messages after it are unread. Null = never opened.
    lastReadAt: timestamptz('last_read_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('conversations_tenant_id_id_key').on(t.tenantId, t.id),
    unique('conversations_tenant_contact_key').on(t.tenantId, t.contactId),
    foreignKey({
      name: 'conversations_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contacts.tenantId, contacts.id],
    }),
    foreignKey({
      name: 'conversations_assignee_fk',
      columns: [t.tenantId, t.assignedUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    index('conversations_tenant_activity_idx').on(t.tenantId, t.lastActivityAt),
    check('conversations_status_check', oneOf(t.status, CONVERSATION_STATUSES)),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: serialIdColumn(),
    tenantId: tenantIdColumn(),
    conversationId: uuid('conversation_id').notNull(),
    // Null until the Cloud API accepts an outbound message.
    waMessageId: text('wa_message_id'),
    // Outbound only: id the panel generates per message, so a retried request is not sent twice.
    clientMessageId: uuid('client_message_id'),
    // Outbound only: why Meta never got it (no credentials, rejected, timeout).
    sendError: text('send_error'),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    author: text('author', { enum: MESSAGE_AUTHORS }).notNull(),
    // The team member who wrote it (author = staff only).
    authorUserId: uuid('author_user_id'),
    type: text('type', { enum: MESSAGE_TYPES }).notNull(),
    // Text as the customer saw it (templates: with their parameters filled in).
    body: text('body'),
    templateId: uuid('template_id'),
    waMediaId: text('wa_media_id'),
    // Timestamp reported by WhatsApp; created_at is when we stored it.
    waTimestamp: timestamptz('wa_timestamp'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // Deduplication by constraint, never by a check in code (design document 8.2):
    // a webhook Meta delivers twice, even to two racing workers, is stored once.
    unique('messages_tenant_wa_message_id_key').on(t.tenantId, t.waMessageId),
    unique('messages_tenant_client_message_id_key').on(t.tenantId, t.clientMessageId),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    foreignKey({
      name: 'messages_author_fk',
      columns: [t.tenantId, t.authorUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: 'messages_template_fk',
      columns: [t.tenantId, t.templateId],
      foreignColumns: [messageTemplates.tenantId, messageTemplates.id],
    }),
    index('messages_conversation_created_idx').on(t.tenantId, t.conversationId, t.createdAt),
    check('messages_direction_check', oneOf(t.direction, MESSAGE_DIRECTIONS)),
    check('messages_author_check', oneOf(t.author, MESSAGE_AUTHORS)),
    check('messages_type_check', oneOf(t.type, MESSAGE_TYPES)),
    // Customers only write inbound; everyone else only writes outbound.
    check('messages_author_direction_check', sql`(${t.direction} = 'in') = (${t.author} = 'customer')`),
    // Staff messages always say who wrote them; nobody else has an author user.
    check('messages_author_user_check', sql`(${t.author} = 'staff') = (${t.authorUserId} is not null)`),
  ],
)

/**
 * Delivery statuses Meta reports, append-only (design document 8.3): a row is never
 * updated or deleted, the current status is derived (view message_delivery_status).
 * A status may arrive before we know the message, so it is keyed by wa_message_id.
 */
export const messageStatusEvents = pgTable(
  'message_status_events',
  {
    id: serialIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    waMessageId: text('wa_message_id').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    pricingCategory: text('pricing_category'),
    billable: boolean('billable'),
    errorText: text('error_text'),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
  },
  (t) => [
    // Meta resends statuses: the same one twice is stored once.
    unique('message_status_events_dedup_key').on(t.tenantId, t.waMessageId, t.status),
    check('message_status_events_status_check', oneOf(t.status, DELIVERY_STATUSES)),
  ],
)

/** Current delivery status per message, derived from the events (drizzle/0001_security_rls.sql). */
export const messageDeliveryStatus = pgView('message_delivery_status', {
  tenantId: uuid('tenant_id').notNull(),
  waMessageId: text('wa_message_id').notNull(),
  status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
  occurredAt: timestamptz('occurred_at').notNull(),
}).existing()

/**
 * Every time a contact moves along the pipeline, kept forever (append-only, written only by a
 * trigger on contacts: drizzle/0025). Who moved it comes from app.user_id, set for each request
 * by withMember(). Reports count the moves into the company's last stage as won sales.
 */
export const contactStageEvents = pgTable(
  'contact_stage_events',
  {
    id: serialIdColumn(),
    tenantId: tenantIdColumn(),
    contactId: uuid('contact_id').notNull(),
    // Null: the contact left the pipeline.
    stageId: uuid('stage_id'),
    // The quote at the moment of the move, in cents.
    quoteCents: integer('quote_cents'),
    // Null when no person did it (a script, the platform).
    changedBy: uuid('changed_by'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({ name: 'contact_stage_events_contact_fk', columns: [t.tenantId, t.contactId], foreignColumns: [contacts.tenantId, contacts.id] }),
    index('contact_stage_events_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
)

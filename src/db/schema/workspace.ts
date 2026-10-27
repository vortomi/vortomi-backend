import { sql } from 'drizzle-orm'
import { check, integer, jsonb, pgTable, text, uniqueIndex, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { RATE_SOURCES, WORK_MODES } from './enums.ts'
import { tenants } from './tenancy.ts'

// How each company works: settings, canned replies and its sales pipeline.

/** One row per company; created on first save, defaults apply until then. */
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    workMode: text('work_mode', { enum: WORK_MODES }).notNull().default('sales_and_support'),
    // [{ day: 0..6, open: "HH:MM" | null, close: "HH:MM" | null }], validated by the API.
    businessHours: jsonb('business_hours').$type<BusinessDay[]>().notNull().default(sql`'[]'::jsonb`),
    // Sent when someone writes outside business hours. Empty = disabled.
    awayMessage: text('away_message').notNull().default(''),
    // Where the company's exchange rate comes from: read from the BCV every hour, or typed by an
    // admin (exchange-rates.ts keeps every rate).
    rateSource: text('rate_source', { enum: RATE_SOURCES }).notNull().default('custom'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('tenant_settings_work_mode_check', oneOf(t.workMode, WORK_MODES)),
    check('tenant_settings_business_hours_check', sql`jsonb_typeof(${t.businessHours}) = 'array'`),
    check('tenant_settings_away_message_check', sql`length(${t.awayMessage}) <= 1024`),
    check('tenant_settings_rate_source_check', oneOf(t.rateSource, RATE_SOURCES)),
  ],
)

export interface BusinessDay {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6
  open: string | null
  close: string | null
}

export const quickReplies = pgTable(
  'quick_replies',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    // Typed after "/" in the composer.
    shortcut: text('shortcut').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex('quick_replies_tenant_shortcut_key').on(t.tenantId, sql`lower(${t.shortcut})`),
    check('quick_replies_shortcut_check', sql`${t.shortcut} ~ '^[a-z0-9_-]{1,30}$'`),
    check('quick_replies_body_check', sql`length(trim(${t.body})) between 1 and 4096`),
  ],
)

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    name: text('name').notNull(),
    color: text('color').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('pipeline_stages_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('pipeline_stages_tenant_name_key').on(t.tenantId, sql`lower(${t.name})`),
    check('pipeline_stages_color_check', sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check('pipeline_stages_position_check', sql`${t.position} >= 0`),
  ],
)

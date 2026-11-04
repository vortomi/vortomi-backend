import { sql } from 'drizzle-orm'
import { boolean, check, integer, jsonb, pgTable, text, uniqueIndex, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { DELIVERY_CHARGES, DELIVERY_MODES, RATE_SOURCES, SALE_UNITS, STOCK_MODES, WORK_MODES } from './enums.ts'
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
    // A company with its own catalog system (catalog-source): price in bolívares at that system's
    // rate, or at the rate above. Ignored without one.
    useSystemRate: boolean('use_system_rate').notNull().default(true),
    // What a new product starts with (set by the welcome from "¿Cómo vendes?"); each product can change it.
    defaultSaleUnit: text('default_sale_unit', { enum: SALE_UNITS }).notNull().default('unit'),
    defaultStockMode: text('default_stock_mode', { enum: STOCK_MODES }).notNull().default('units'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('tenant_settings_work_mode_check', oneOf(t.workMode, WORK_MODES)),
    check('tenant_settings_business_hours_check', sql`jsonb_typeof(${t.businessHours}) = 'array'`),
    check('tenant_settings_away_message_check', sql`length(${t.awayMessage}) <= 1024`),
    check('tenant_settings_rate_source_check', oneOf(t.rateSource, RATE_SOURCES)),
    check('tenant_settings_default_sale_unit_check', oneOf(t.defaultSaleUnit, SALE_UNITS)),
    check('tenant_settings_default_stock_mode_check', oneOf(t.defaultStockMode, STOCK_MODES)),
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

/** A delivery zone and what it costs, in US cents. */
export interface DeliveryZone {
  name: string
  priceCents: number
}

/**
 * How a company delivers, one row per company. No row: it never said (the agent then leaves the
 * cost to a person). enabled false: it does not deliver, only pickup.
 */
export const deliverySettings = pgTable(
  'delivery_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    enabled: boolean('enabled').notNull().default(false),
    mode: text('mode', { enum: DELIVERY_MODES }).notNull().default('zones'),
    flatPriceCents: integer('flat_price_cents').notNull().default(0),
    charge: text('charge', { enum: DELIVERY_CHARGES }).notNull().default('per_order'),
    // [{ name, priceCents }], names unique ignoring case (validated by the API).
    zones: jsonb('zones').$type<DeliveryZone[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('delivery_settings_mode_check', oneOf(t.mode, DELIVERY_MODES)),
    check('delivery_settings_charge_check', oneOf(t.charge, DELIVERY_CHARGES)),
    check('delivery_settings_flat_price_check', sql`${t.flatPriceCents} between 0 and 100000000`),
    check('delivery_settings_zones_check', sql`jsonb_typeof(${t.zones}) = 'array' and jsonb_array_length(${t.zones}) <= 100`),
  ],
)

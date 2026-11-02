import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { CHANNEL_STATUSES, SELLS, SELL_METHODS, TENANT_PLANS, TENANT_STATUSES } from './enums.ts'

/**
 * The business types a company picks from (block C): one closed list for the welcome, the
 * console and reports. Our team adds new ones from what companies wrote under «Otro»; a type
 * without its own preset gets the general one. Platform data: no tenant_id.
 */
export const businessTypes = pgTable(
  'business_types',
  {
    code: text('code').primaryKey(),
    label: text('label').notNull(),
    // The panel's icon for it (its own set); types added from the console use a generic one.
    icon: text('icon').notNull().default('tag'),
    position: integer('position').notNull().default(50),
    createdAt: createdAtColumn(),
  },
  (t) => [
    check('business_types_code_check', sql`${t.code} ~ '^[a-z0-9_]{2,40}$'`),
    check('business_types_label_check', sql`length(trim(${t.label})) between 1 and 60`),
    uniqueIndex('business_types_label_key').on(sql`lower(${t.label})`),
  ],
)

/** A company on the platform. Everything else hangs from it (documentations/03). */
export const tenants = pgTable(
  'tenants',
  {
    id: uuidIdColumn(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('draft'),
    plan: text('plan', { enum: TENANT_PLANS }).notNull(),
    // Reports and the 24 h window are computed in the company's zone.
    timezone: text('timezone').notNull().default('America/Caracas'),
    legalName: text('legal_name').notNull(),
    // Venezuelan RIF, normalised: J-41234567-8.
    taxId: text('tax_id').notNull(),
    fiscalAddress: text('fiscal_address').notNull(),
    // Its business type, from the closed list; null until our team or the welcome sets it.
    businessType: text('business_type').references(() => businessTypes.code),
    // What it wrote under «Otro», for our team to classify; never used to decide anything.
    businessTypeOther: text('business_type_other').notNull().default(''),
    sells: text('sells', { enum: SELLS }),
    sellMethod: text('sell_method', { enum: SELL_METHODS }),
    // The welcome was done or skipped: it no longer opens by itself (Ajustes can open it again).
    setupCompletedAt: timestamptz('setup_completed_at'),
    city: text('city').notNull().default(''),
    createdAt: createdAtColumn(),
  },
  (t) => [
    check('tenants_status_check', oneOf(t.status, TENANT_STATUSES)),
    check('tenants_plan_check', oneOf(t.plan, TENANT_PLANS)),
    check('tenants_tax_id_check', sql`${t.taxId} ~ '^[JVEGPC]-[0-9]{8}-[0-9]$'`),
    check('tenants_sells_check', oneOf(t.sells, SELLS)),
    check('tenants_sell_method_check', oneOf(t.sellMethod, SELL_METHODS)),
    check('tenants_business_type_other_check', sql`length(${t.businessTypeOther}) <= 60`),
  ],
)

/**
 * A WhatsApp number of a company. The global UNIQUE on phone_number_id is what
 * routes every Meta event to exactly one company: a number can never be in two.
 */
export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    wabaId: text('waba_id').notNull(),
    phoneNumberId: text('phone_number_id').notNull().unique(),
    displayNumber: text('display_number').notNull(),
    label: text('label').notNull(),
    status: text('status', { enum: CHANNEL_STATUSES }).notNull().default('connected'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // Target of the composite foreign keys: children can only point to a number of their own company.
    unique('channel_accounts_tenant_id_id_key').on(t.tenantId, t.id),
    index('channel_accounts_tenant_idx').on(t.tenantId),
    check('channel_accounts_status_check', oneOf(t.status, CHANNEL_STATUSES)),
    check('channel_accounts_phone_number_id_check', sql`${t.phoneNumberId} ~ '^[0-9]+$'`),
  ],
)

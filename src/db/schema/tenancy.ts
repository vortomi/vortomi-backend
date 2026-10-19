import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, uuidIdColumn } from './columns.ts'
import { CHANNEL_STATUSES, TENANT_PLANS, TENANT_STATUSES } from './enums.ts'

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
    createdAt: createdAtColumn(),
  },
  (t) => [
    check('tenants_status_check', oneOf(t.status, TENANT_STATUSES)),
    check('tenants_plan_check', oneOf(t.plan, TENANT_PLANS)),
    check('tenants_tax_id_check', sql`${t.taxId} ~ '^[JVEGPC]-[0-9]{8}-[0-9]$'`),
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

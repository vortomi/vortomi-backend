import { sql } from 'drizzle-orm'
import { boolean, check, date, index, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { RATE_ORIGINS } from './enums.ts'
import { users } from './access.ts'
import { tenants } from './tenancy.ts'

/**
 * Every exchange rate a company used, append-only (drizzle/0028): the company's rate is its
 * latest row by created_at. Orders will copy it when quoted, so a later rate never changes them.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    // Bolívares per dollar, as text in the API: no floating point on the way.
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    // "Vigente desde": the BCV's fecha valor, or the day the admin typed.
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    // The company's rate just before this one; null for the first.
    previousRate: numeric('previous_rate', { precision: 18, scale: 8 }),
    source: text('source', { enum: RATE_ORIGINS }).notNull(),
    // Who typed it; null for the BCV's (and for rates carried over from the old settings field).
    changedBy: uuid('changed_by').references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('exchange_rates_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    check('exchange_rates_rate_check', sql`${t.rate} > 0`),
    check('exchange_rates_source_check', oneOf(t.source, RATE_ORIGINS)),
    // The BCV's rows have no author; a typed rate always has one (the old field's carry-over aside).
    check('exchange_rates_author_check', sql`${t.source} = 'manual' or ${t.changedBy} is null`),
  ],
)

/**
 * The platform's last read of the BCV, one row for every company (the rate is the same for all):
 * what it published, for which day, when it was read and why the last read failed.
 */
export const bcvStatus = pgTable(
  'bcv_status',
  {
    // Always true: the table holds exactly one row.
    id: boolean('id').primaryKey().default(true),
    rate: numeric('rate', { precision: 18, scale: 8 }),
    effectiveDate: date('effective_date', { mode: 'string' }),
    checkedAt: timestamptz('checked_at'),
    // Why the last read failed, in Spanish (the panel shows it as is); null when it worked.
    error: text('error'),
  },
  (t) => [check('bcv_status_single_row_check', sql`${t.id}`)],
)

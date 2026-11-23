import { sql } from 'drizzle-orm'
import { boolean, check, date, index, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, timestamptz, uuidIdColumn } from './columns.ts'
import { RATE_ORIGINS, RATE_SOURCES } from './enums.ts'
import { users } from './access.ts'

/**
 * Vortomi's own exchange rates (console → Ajustes → Tasa de cambio, mockup web-36), append-only
 * like a company's (exchange_rates): Vortomi's rate is its latest row. It turns into bolívares what
 * companies pay for their plan; it never touches any company's own rate.
 */
export const platformExchangeRates = pgTable(
  'platform_exchange_rates',
  {
    id: uuidIdColumn(),
    // Bolívares per dollar, as text in the API: no floating point on the way.
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    // "Vigente desde": the BCV's fecha valor, or the day the staff member typed.
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    previousRate: numeric('previous_rate', { precision: 18, scale: 8 }),
    source: text('source', { enum: RATE_ORIGINS }).notNull(),
    // Who typed it; null for the BCV's.
    changedBy: uuid('changed_by').references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('platform_exchange_rates_created_idx').on(t.createdAt.desc()),
    check('platform_exchange_rates_rate_check', sql`${t.rate} > 0`),
    check('platform_exchange_rates_source_check', oneOf(t.source, RATE_ORIGINS)),
    // A typed rate always has its author; the BCV's never does.
    check('platform_exchange_rates_author_check', sql`(${t.source} = 'manual') = (${t.changedBy} is not null)`),
  ],
)

/** Vortomi's own settings: one row (like bcv_status). For now, where its exchange rate comes from. */
export const platformSettings = pgTable(
  'platform_settings',
  {
    // Always true: the table holds exactly one row.
    id: boolean('id').primaryKey().default(true),
    rateSource: text('rate_source', { enum: RATE_SOURCES }).notNull().default('custom'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_single_row_check', sql`${t.id}`),
    check('platform_settings_rate_source_check', oneOf(t.rateSource, RATE_SOURCES)),
  ],
)

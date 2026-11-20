import { sql } from 'drizzle-orm'
import { boolean, check, integer, jsonb, pgTable, smallint, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAtColumn, timestamptz, uuidIdColumn } from './columns.ts'

/**
 * Vortomi's plans (console → Suscripciones → Planes, mockup web-34): what a company can subscribe to.
 * A base price per month and a discount for paying 1, 3, 6 or 12 months, set per plan. Suspended
 * (is_active false): hidden and not chosen by anyone new; the companies on it keep it. Companies do
 * not see these plans yet. Only the console reads or writes this table.
 */
export const platformPlans = pgTable(
  'platform_plans',
  {
    id: uuidIdColumn(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    priceCents: integer('price_cents').notNull(),
    // Percent off the base price when paying at least that many months.
    discount1: smallint('discount_1').notNull().default(0),
    discount3: smallint('discount_3').notNull().default(0),
    discount6: smallint('discount_6').notNull().default(0),
    discount12: smallint('discount_12').notNull().default(0),
    benefits: jsonb('benefits').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Two plans never share a name, whatever the case or the spaces around it.
    uniqueIndex('platform_plans_name_key').on(sql`lower(btrim(${t.name}))`),
    check('platform_plans_name_check', sql`length(btrim(${t.name})) between 2 and 60`),
    check('platform_plans_description_check', sql`length(${t.description}) <= 500`),
    check('platform_plans_price_check', sql`${t.priceCents} between 1 and 10000000`),
    check(
      'platform_plans_discounts_check',
      sql`${t.discount1} between 0 and 90 and ${t.discount3} between 0 and 90 and ${t.discount6} between 0 and 90 and ${t.discount12} between 0 and 90`,
    ),
    check('platform_plans_benefits_check', sql`jsonb_typeof(${t.benefits}) = 'array' and jsonb_array_length(${t.benefits}) <= 12`),
  ],
)

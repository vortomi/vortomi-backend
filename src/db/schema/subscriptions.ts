import { sql } from 'drizzle-orm'
import { check, date, index, integer, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { users } from './access.ts'
import { platformPlans } from './platform-plans.ts'
import { tenants } from './tenancy.ts'

/** The plan's discount for paying at least 1, 3, 6 or 12 months, copied into each charge. */
export type ChargeDiscounts = Record<'1' | '3' | '6' | '12', number>

/**
 * A company's subscription to one of Vortomi's plans (documentations/18, mockup web-37). Its
 * billing day is set by its first payment; until then the first charge is due the day the plan was
 * assigned, with the same 2 days of grace as any other. The state (waiting for the first payment,
 * up to date, due soon, in grace, suspended) is computed from these dates, never stored.
 */
export const companySubscriptions = pgTable(
  'company_subscriptions',
  {
    tenantId: uuid('company_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // A plan with companies on it is never deleted (restrict): suspended at most.
    planId: uuid('plan_id')
      .notNull()
      .references(() => platformPlans.id),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    assignedBy: uuid('assigned_by').references(() => users.id),
    // Day of the month every payment is due; null until the first payment.
    billingDay: smallint('billing_day'),
    // The day the first unpaid charge is due (Caracas calendar).
    nextDueOn: date('next_due_on', { mode: 'string' }).notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('company_subscriptions_billing_day_check', sql`${t.billingDay} is null or ${t.billingDay} between 1 and 31`)],
)

/**
 * What a company owes for one period. Everything about the plan is copied when the charge is made,
 * so a later change of price or discount reaches it only from its next charge. The company chooses
 * the months when it pays (1 by default); they stay fixed once a payment is applied.
 */
export const subscriptionCharges = pgTable(
  'subscription_charges',
  {
    id: uuidIdColumn(),
    tenantId: uuid('company_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => platformPlans.id),
    planName: text('plan_name').notNull(),
    basePriceCents: integer('base_price_cents').notNull(),
    discounts: jsonb('discounts').$type<ChargeDiscounts>().notNull(),
    months: smallint('months').notNull().default(1),
    discountPercent: smallint('discount_percent').notNull().default(0),
    amountCents: integer('amount_cents').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    // What the approved payments add up to (payments come in stages 3 and 4).
    paidCents: integer('paid_cents').notNull().default(0),
    paidAt: timestamptz('paid_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('subscription_charges_company_due_idx').on(t.tenantId, t.dueOn),
    check('subscription_charges_months_check', sql`${t.months} between 1 and 36`),
    check('subscription_charges_discount_check', sql`${t.discountPercent} between 0 and 90`),
    check('subscription_charges_amounts_check', sql`${t.basePriceCents} > 0 and ${t.amountCents} > 0 and ${t.paidCents} >= 0`),
  ],
)

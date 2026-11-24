import { sql } from 'drizzle-orm'
import { check, date, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { users } from './access.ts'
import { platformPaymentMethods } from './platform-payment-methods.ts'
import { subscriptionCharges } from './subscriptions.ts'
import { tenants } from './tenancy.ts'

/** In review until the console decides (stage 4); a rejected one is corrected and sent again. */
export const SUBSCRIPTION_PAYMENT_STATUSES = ['in_review', 'approved', 'rejected'] as const
export type SubscriptionPaymentStatus = (typeof SUBSCRIPTION_PAYMENT_STATUSES)[number]

/** The currencies a company may pay Vortomi in: Vortomi only has a rate for the dollar. */
export const SUBSCRIPTION_PAYMENT_CURRENCIES = ['USD', 'VES'] as const
export type SubscriptionPaymentCurrency = (typeof SUBSCRIPTION_PAYMENT_CURRENCIES)[number]

/**
 * Who paid, as each kind of method identifies it (mockup web-40): the bank, phone and ID of a pago
 * móvil, the sender of a Zelle, the Binance ID of a Binance payment… Checked by the method's form
 * (subscription-payment-forms.ts) before it is kept.
 */
export type PayerDetails = Record<string, string>

/**
 * A payment a company reports to Vortomi for its subscription (documentations/18, §5; mockups web-39
 * and web-40). It pays the open charge (charge_id), or, with nothing owed, the next period in advance
 * (charge_id null, its months kept). The amount is in the method's currency and converted to dollars
 * with Vortomi's rate of the payment day. The receipt is private (Supabase), read only through our API.
 */
export const subscriptionPayments = pgTable(
  'subscription_payments',
  {
    id: uuidIdColumn(),
    tenantId: uuid('company_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    chargeId: uuid('charge_id').references(() => subscriptionCharges.id, { onDelete: 'set null' }),
    months: smallint('months').notNull(),
    // The method as it was when the company paid: a method edited or hidden later does not change it.
    methodId: uuid('method_id').references(() => platformPaymentMethods.id, { onDelete: 'set null' }),
    methodName: text('method_name').notNull(),
    methodType: text('method_type').notNull(),
    currency: text('currency', { enum: SUBSCRIPTION_PAYMENT_CURRENCIES }).notNull(),
    payer: jsonb('payer').$type<PayerDetails>().notNull().default(sql`'{}'::jsonb`),
    // As the bank prints it, without spaces, in capitals; null for methods without one (cash).
    reference: text('reference'),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    // Bolívares per dollar used for the conversion (null for a payment in dollars).
    bsPerUsd: numeric('bs_per_usd', { precision: 18, scale: 8 }),
    amountUsdCents: integer('amount_usd_cents').notNull(),
    proofKey: text('proof_key'),
    proofMimeType: text('proof_mime_type'),
    proofSizeBytes: integer('proof_size_bytes'),
    status: text('status', { enum: SUBSCRIPTION_PAYMENT_STATUSES }).notNull().default('in_review'),
    rejectionReason: text('rejection_reason'),
    rejectionNote: text('rejection_note'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamptz('reviewed_at'),
    submittedBy: uuid('submitted_by').references(() => users.id),
    submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('subscription_payments_company_idx').on(t.tenantId, t.submittedAt),
    // One payment in review at a time per company.
    uniqueIndex('subscription_payments_one_in_review').on(t.tenantId).where(sql`${t.status} = 'in_review'`),
    // The same reference never pays twice with the same method (a rejected one may be sent again).
    uniqueIndex('subscription_payments_reference_unique')
      .on(t.methodId, t.reference)
      .where(sql`${t.status} <> 'rejected' and ${t.reference} is not null and ${t.methodId} is not null`),
    check('subscription_payments_status_check', sql`${t.status} in ('in_review', 'approved', 'rejected')`),
    check('subscription_payments_currency_check', sql`${t.currency} in ('USD', 'VES')`),
    check('subscription_payments_amount_check', sql`${t.amount} > 0 and ${t.amountUsdCents} > 0`),
    check('subscription_payments_months_check', sql`${t.months} between 1 and 36`),
  ],
)

import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, serial, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, uuidIdColumn } from './columns.ts'
import { subscriptionPayments } from './subscription-payments.ts'
import { subscriptionCharges } from './subscriptions.ts'
import { tenants } from './tenancy.ts'

/**
 * Why a company's balance with Vortomi moved: a payment that brought more than it owed, or the
 * balance used on a charge when it fell due (documentations/18 §4 bis). Withdrawals come later.
 */
export const WALLET_MOVEMENT_KINDS = ['excess', 'applied'] as const
export type WalletMovementKind = (typeof WALLET_MOVEMENT_KINDS)[number]

/**
 * A company's balance in favour, in dollar cents: never edited by hand, the sum of these
 * movements. Positive adds (an excess), negative takes (applied to a charge).
 */
export const walletMovements = pgTable(
  'wallet_movements',
  {
    id: uuidIdColumn(),
    tenantId: uuid('company_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: WALLET_MOVEMENT_KINDS }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    paymentId: uuid('payment_id').references(() => subscriptionPayments.id, { onDelete: 'set null' }),
    chargeId: uuid('charge_id').references(() => subscriptionCharges.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('wallet_movements_company_idx').on(t.tenantId, t.createdAt),
    check('wallet_movements_kind_check', sql`${t.kind} in ('excess', 'applied')`),
    check('wallet_movements_sign_check', sql`(${t.kind} = 'excess' and ${t.amountCents} > 0) or (${t.kind} = 'applied' and ${t.amountCents} < 0)`),
  ],
)

/** Everything printed on a receipt, kept as it was the day it was issued (documentations/18 §7). */
export interface ReceiptSnapshot {
  company: { name: string; legalName: string | null; taxId: string | null; address: string | null }
  plan: string
  months: number
  /** The period the charge pays, "YYYY-MM-DD"; null for an advance that only went to the balance. */
  period: { from: string; to: string } | null
  basePriceCents: number
  discountPercent: number
  /** What the charge comes to. */
  chargeCents: number
  /** Paid towards it before this payment (other payments, the balance). */
  paidBeforeCents: number
  /** What this payment brought, in dollar cents, and how much of it went to the charge and to the balance. */
  receivedCents: number
  appliedCents: number
  excessCents: number
  /** Still owed on the charge after this payment. */
  pendingCents: number
  method: string
  reference: string | null
  paidOn: string
  amount: string
  currency: 'USD' | 'VES'
  bsPerUsd: string | null
  nextDueOn: string | null
}

/** One receipt per approved payment, with a correlative number (VTM-000001). */
export const subscriptionReceipts = pgTable(
  'subscription_receipts',
  {
    id: uuidIdColumn(),
    number: serial('number').notNull(),
    tenantId: uuid('company_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => subscriptionPayments.id, { onDelete: 'cascade' }),
    data: jsonb('data').$type<ReceiptSnapshot>().notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex('subscription_receipts_payment_unique').on(t.paymentId), uniqueIndex('subscription_receipts_number_unique').on(t.number)],
)

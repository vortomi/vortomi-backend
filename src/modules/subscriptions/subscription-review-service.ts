import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import {
  companySubscriptions,
  platformPlans,
  subscriptionCharges,
  subscriptionPayments,
  subscriptionReceipts,
  tenants,
  walletMovements,
} from '../../db/schema/index.ts'
import type { ReceiptSnapshot } from '../../db/schema/subscription-ledger.ts'
import { PAYMENT_REJECTION_REASONS, type SubscriptionPaymentStatus } from '../../db/schema/subscription-payments.ts'
import type { MediaFile } from '../chat-media/media-store.ts'
import type { PaymentProofStore } from './payment-proof-store.ts'
import { receiptCode, receiptPdf } from './receipt-pdf.ts'
import { amountInput, toUsdCents } from './subscription-payment-forms.ts'
import { PaymentRuleError, type PaymentView, RECEIPT_NUMBER } from './subscription-payment-service.ts'
import { addMonthsOn, chargeFor, dayOfMonth } from './subscription-rules.ts'

export const approvePaymentInput = z.object({
  // What really arrived, in the method's currency; left out, what was reported.
  receivedAmount: amountInput.optional(),
})
export const rejectPaymentInput = z.object({
  reason: z.enum(PAYMENT_REJECTION_REASONS),
  note: z.string().trim().max(300).default(''),
})
export const reviewStatusQuery = z.object({ status: z.enum(['in_review', 'approved', 'rejected', 'all']).default('in_review') })

/** How a payment compares with what its company owes now. */
export type Coverage = 'full' | 'partial' | 'extra'

/** A row of Suscripciones → Pagos (mockup web-41, frame 1). */
export interface ReviewRow {
  id: string
  tenantId: string
  tenantName: string
  status: SubscriptionPaymentStatus
  planName: string | null
  months: number
  methodName: string
  reference: string | null
  paidOn: string
  submittedAt: Date
  currency: 'USD' | 'VES'
  amount: string
  amountUsdCents: number
  owedCents: number
  coverage: Coverage
  receiptNumber: number | null
}

/** One payment to review (frame 2): what it reported, and what its company owes. */
export interface ReviewDetail extends ReviewRow {
  payment: PaymentView & { receivedAmount: string | null; receivedUsdCents: number | null }
  charge: { months: number; amountCents: number; paidCents: number; dueOn: string; discountPercent: number } | null
  billingDay: number | null
  nextDueOn: string | null
}

const coverageOf = (cents: number, owed: number): Coverage => (owed <= 0 || cents > owed + 1 ? 'extra' : cents >= owed - 1 ? 'full' : 'partial')

/**
 * The console's review of the payments companies report (documentations/18 §6 and §7; mockup
 * web-41). Approving credits what really arrived to the charge being paid: a period paid in full
 * sets the billing day (the first time) and moves the next due day; what is left over goes to the
 * company's balance in favour; every approval issues a receipt. Rejecting says why; the company
 * corrects it. Reached only through the console's routes.
 */
export class SubscriptionReviewService {
  constructor(
    private readonly db: Database,
    private readonly proofs: PaymentProofStore | null,
  ) {}

  /** Oldest first while waiting (the queue); newest first otherwise. */
  async list(status: SubscriptionPaymentStatus | 'all', onlyId?: string): Promise<ReviewRow[]> {
    const rows = await this.db
      .select({
        id: subscriptionPayments.id,
        tenantId: subscriptionPayments.tenantId,
        tenantName: tenants.name,
        status: subscriptionPayments.status,
        planName: platformPlans.name,
        months: subscriptionPayments.months,
        methodName: subscriptionPayments.methodName,
        reference: subscriptionPayments.reference,
        paidOn: subscriptionPayments.paidOn,
        submittedAt: subscriptionPayments.submittedAt,
        currency: subscriptionPayments.currency,
        amount: subscriptionPayments.amount,
        amountUsdCents: subscriptionPayments.amountUsdCents,
        owedCents: sql<number>`coalesce((select sum(c.amount_cents - c.paid_cents) from subscription_charges c where c.company_id = ${subscriptionPayments.tenantId}), 0)::int`,
        receiptNumber: subscriptionReceipts.number,
      })
      .from(subscriptionPayments)
      .innerJoin(tenants, eq(tenants.id, subscriptionPayments.tenantId))
      .leftJoin(companySubscriptions, eq(companySubscriptions.tenantId, subscriptionPayments.tenantId))
      .leftJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
      .leftJoin(subscriptionReceipts, eq(subscriptionReceipts.paymentId, subscriptionPayments.id))
      .where(and(status === 'all' ? undefined : eq(subscriptionPayments.status, status), onlyId ? eq(subscriptionPayments.id, onlyId) : undefined))
      .orderBy(status === 'in_review' ? asc(subscriptionPayments.submittedAt) : desc(subscriptionPayments.submittedAt))
    return rows.map((r) => ({ ...r, coverage: coverageOf(r.amountUsdCents, r.owedCents) }))
  }

  /** How many wait for review: the console's menu shows it. */
  async pendingCount(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(subscriptionPayments).where(eq(subscriptionPayments.status, 'in_review'))
    return row?.n ?? 0
  }

  async detail(paymentId: string): Promise<ReviewDetail> {
    const [row] = await this.list('all', paymentId)
    if (!row) throw new PaymentRuleError('payment_not_found', 404)
    const [payment] = await this.db
      .select({
        id: subscriptionPayments.id,
        status: subscriptionPayments.status,
        months: subscriptionPayments.months,
        methodId: subscriptionPayments.methodId,
        methodName: subscriptionPayments.methodName,
        methodType: subscriptionPayments.methodType,
        currency: subscriptionPayments.currency,
        payer: subscriptionPayments.payer,
        reference: subscriptionPayments.reference,
        paidOn: subscriptionPayments.paidOn,
        amount: subscriptionPayments.amount,
        bsPerUsd: subscriptionPayments.bsPerUsd,
        amountUsdCents: subscriptionPayments.amountUsdCents,
        hasProof: sql<boolean>`${subscriptionPayments.proofKey} is not null`,
        rejectionReason: subscriptionPayments.rejectionReason,
        rejectionNote: subscriptionPayments.rejectionNote,
        submittedAt: subscriptionPayments.submittedAt,
        reviewedAt: subscriptionPayments.reviewedAt,
        receiptNumber: RECEIPT_NUMBER,
        receivedAmount: subscriptionPayments.receivedAmount,
        receivedUsdCents: subscriptionPayments.receivedUsdCents,
        chargeId: subscriptionPayments.chargeId,
      })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, paymentId))
    const [sub] = await this.db
      .select({ billingDay: companySubscriptions.billingDay, nextDueOn: companySubscriptions.nextDueOn })
      .from(companySubscriptions)
      .where(eq(companySubscriptions.tenantId, row.tenantId))
    const charge = await this.openCharge(this.db, row.tenantId)
    const { chargeId: _chargeId, ...view } = payment!
    return { ...row, payment: view, charge, billingDay: sub?.billingDay ?? null, nextDueOn: sub?.nextDueOn ?? null }
  }

  /** The receipt a payment was sent with. */
  async proof(tenantId: string, paymentId: string): Promise<MediaFile> {
    const [row] = await this.db
      .select({ key: subscriptionPayments.proofKey })
      .from(subscriptionPayments)
      .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId)))
    if (!row?.key) throw new PaymentRuleError('payment_not_found', 404)
    if (!this.proofs) throw new PaymentRuleError('proof_store_unavailable', 503)
    return this.proofs.get(row.key)
  }

  /** Approves for what really arrived; one receipt per approval. */
  async approve(tenantId: string, paymentId: string, reviewerId: string, receivedAmount?: string): Promise<ReviewDetail> {
    await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(subscriptionPayments)
        .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId)))
        .for('update')
      if (!p) throw new PaymentRuleError('payment_not_found', 404)
      if (p.status !== 'in_review') throw new PaymentRuleError('payment_not_in_review', 409)
      const received = receivedAmount ?? p.amount
      const receivedCents = toUsdCents(received, p.currency, p.bsPerUsd)
      const [sub] = await tx.select().from(companySubscriptions).where(eq(companySubscriptions.tenantId, tenantId)).for('update')
      if (!sub) throw new PaymentRuleError('no_subscription', 409)
      const [plan] = await tx.select().from(platformPlans).where(eq(platformPlans.id, sub.planId))
      const [company] = await tx
        .select({ name: tenants.name, legalName: tenants.legalName, taxId: tenants.taxId, address: tenants.fiscalAddress })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
      const charge = await this.openCharge(tx, tenantId, true)

      let snapshot: Omit<ReceiptSnapshot, 'company' | 'method' | 'reference' | 'paidOn' | 'amount' | 'currency' | 'bsPerUsd'>
      if (charge) {
        // The open charge gets what arrived, up to what it still owes.
        const applied = Math.min(receivedCents, charge.amountCents - charge.paidCents)
        const excess = receivedCents - applied
        const paidCents = charge.paidCents + applied
        const complete = paidCents >= charge.amountCents
        await tx
          .update(subscriptionCharges)
          .set({ paidCents, ...(complete ? { paidAt: sql`now()` } : {}) })
          .where(eq(subscriptionCharges.id, charge.id))
        // The first payment sets the billing day; then each period runs from the due day it pays.
        const billingDay = sub.billingDay ?? dayOfMonth(p.paidOn)
        const from = sub.billingDay === null ? p.paidOn : charge.dueOn
        const to = addMonthsOn(from, charge.months, billingDay)
        if (complete) await tx.update(companySubscriptions).set({ billingDay, nextDueOn: to, updatedAt: sql`now()` }).where(eq(companySubscriptions.tenantId, tenantId))
        if (excess > 0) await tx.insert(walletMovements).values({ tenantId, kind: 'excess', amountCents: excess, paymentId })
        snapshot = {
          plan: plan?.name ?? 'Vortomi',
          months: charge.months,
          period: { from, to },
          basePriceCents: charge.basePriceCents,
          discountPercent: charge.discountPercent,
          chargeCents: charge.amountCents,
          paidBeforeCents: charge.paidCents,
          receivedCents,
          appliedCents: applied,
          excessCents: excess,
          pendingCents: charge.amountCents - paidCents,
          nextDueOn: complete ? to : sub.nextDueOn,
        }
      } else {
        // Nothing owed: an advance. Whole, it pays the next period and moves the date; less, it waits in the balance.
        const discounts = { '1': plan!.discount1, '3': plan!.discount3, '6': plan!.discount6, '12': plan!.discount12 }
        const price = chargeFor(plan!.priceCents, discounts, p.months)
        const billingDay = sub.billingDay ?? dayOfMonth(sub.nextDueOn)
        if (receivedCents >= price.amountCents - 1) {
          const to = addMonthsOn(sub.nextDueOn, p.months, billingDay)
          const paid = Math.min(receivedCents, price.amountCents)
          await tx.insert(subscriptionCharges).values({
            tenantId,
            planId: plan!.id,
            planName: plan!.name,
            basePriceCents: plan!.priceCents,
            discounts,
            months: p.months,
            discountPercent: price.discountPercent,
            amountCents: price.amountCents,
            dueOn: sub.nextDueOn,
            paidCents: paid,
            paidAt: sql`now()`,
          })
          await tx.update(companySubscriptions).set({ nextDueOn: to, updatedAt: sql`now()` }).where(eq(companySubscriptions.tenantId, tenantId))
          const excess = receivedCents - paid
          if (excess > 0) await tx.insert(walletMovements).values({ tenantId, kind: 'excess', amountCents: excess, paymentId })
          snapshot = {
            plan: plan!.name,
            months: p.months,
            period: { from: sub.nextDueOn, to },
            basePriceCents: plan!.priceCents,
            discountPercent: price.discountPercent,
            chargeCents: price.amountCents,
            paidBeforeCents: 0,
            receivedCents,
            appliedCents: paid,
            excessCents: excess,
            pendingCents: 0,
            nextDueOn: to,
          }
        } else {
          await tx.insert(walletMovements).values({ tenantId, kind: 'excess', amountCents: receivedCents, paymentId })
          snapshot = {
            plan: plan!.name,
            months: p.months,
            period: null,
            basePriceCents: plan!.priceCents,
            discountPercent: 0,
            chargeCents: 0,
            paidBeforeCents: 0,
            receivedCents,
            appliedCents: 0,
            excessCents: receivedCents,
            pendingCents: 0,
            nextDueOn: sub.nextDueOn,
          }
        }
      }

      await tx
        .update(subscriptionPayments)
        .set({ status: 'approved', receivedAmount: received, receivedUsdCents: receivedCents, reviewedBy: reviewerId, reviewedAt: sql`now()` })
        .where(eq(subscriptionPayments.id, paymentId))
      await tx.insert(subscriptionReceipts).values({
        tenantId,
        paymentId,
        data: {
          ...snapshot,
          company: { name: company!.name, legalName: company!.legalName, taxId: company!.taxId, address: company!.address },
          method: p.methodName,
          reference: p.reference,
          paidOn: p.paidOn,
          amount: received,
          currency: p.currency,
          bsPerUsd: p.bsPerUsd,
        },
      })
    })
    return this.detail(paymentId)
  }

  async reject(tenantId: string, paymentId: string, reviewerId: string, reason: string, note: string): Promise<ReviewDetail> {
    const updated = await this.db
      .update(subscriptionPayments)
      .set({ status: 'rejected', rejectionReason: reason, rejectionNote: note || null, reviewedBy: reviewerId, reviewedAt: sql`now()` })
      .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId), eq(subscriptionPayments.status, 'in_review')))
      .returning({ id: subscriptionPayments.id })
    if (!updated.length) {
      const [exists] = await this.db.select({ id: subscriptionPayments.id }).from(subscriptionPayments).where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId)))
      throw exists ? new PaymentRuleError('payment_not_in_review', 409) : new PaymentRuleError('payment_not_found', 404)
    }
    return this.detail(paymentId)
  }

  /** The PDF receipt of an approved payment of a company. */
  async receipt(tenantId: string, paymentId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return receiptFile(this.db, tenantId, paymentId)
  }

  /** The charge being paid now (the oldest not paid in full), locked when asked. */
  private async openCharge(executor: Executor, tenantId: string, lock = false) {
    const query = executor
      .select({
        id: subscriptionCharges.id,
        months: subscriptionCharges.months,
        amountCents: subscriptionCharges.amountCents,
        paidCents: subscriptionCharges.paidCents,
        dueOn: subscriptionCharges.dueOn,
        discountPercent: subscriptionCharges.discountPercent,
        basePriceCents: subscriptionCharges.basePriceCents,
      })
      .from(subscriptionCharges)
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`))
      .orderBy(asc(subscriptionCharges.dueOn), asc(subscriptionCharges.createdAt))
      .limit(1)
    const [charge] = lock ? await query.for('update') : await query
    return charge ?? null
  }
}

/** The PDF receipt of one approved payment (company or console): its number names the file. */
export async function receiptFile(executor: Executor, tenantId: string, paymentId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const [receipt] = await executor
    .select({ number: subscriptionReceipts.number, data: subscriptionReceipts.data, createdAt: subscriptionReceipts.createdAt })
    .from(subscriptionReceipts)
    .where(and(eq(subscriptionReceipts.paymentId, paymentId), eq(subscriptionReceipts.tenantId, tenantId)))
  if (!receipt) throw new PaymentRuleError('receipt_not_found', 404)
  return { bytes: await receiptPdf(receipt.number, receipt.createdAt, receipt.data), fileName: `Recibo-${receiptCode(receipt.number)}.pdf` }
}

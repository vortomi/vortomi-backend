import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { companySubscriptions, platformExchangeRates, platformPaymentMethods, subscriptionCharges, subscriptionPayments } from '../../db/schema/index.ts'
import type { PaymentMethodType, PaymentProofRule } from '../../db/schema/enums.ts'
import type { PaymentField } from '../../db/schema/payment-methods.ts'
import type { PayerDetails, SubscriptionPaymentCurrency, SubscriptionPaymentStatus } from '../../db/schema/subscription-payments.ts'
import type { MediaFile } from '../chat-media/media-store.ts'
import type { PaymentProofStore } from './payment-proof-store.ts'
import {
  type ProofInput,
  amountInput,
  checkPayer,
  payableType,
  paymentCurrency,
  proofInput,
  readProof,
  toUsdCents,
} from './subscription-payment-forms.ts'
import { addDays, caracasToday, chargeFor } from './subscription-rules.ts'

/** How many days back a payment may still be reported (decided 24/11/2026): after that, Vortomi's support. */
export const REPORT_WINDOW_DAYS = 7

export const reportPaymentInput = z.object({
  methodId: z.uuid(),
  months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  paidOn: z.iso.date(),
  amount: amountInput,
  reference: z.string().max(60).optional(),
  payer: z.record(z.string().max(30), z.string().max(120)).default({}),
  // Left out when correcting a rejected payment: its receipt stays.
  proof: proofInput.nullable().optional(),
})
export type ReportPaymentInput = z.infer<typeof reportPaymentInput>

/** A payment breaks one of the rules of documentations/18 §5; `code` says which. */
export class PaymentRuleError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(`Payment rule: ${code}`)
    this.name = 'PaymentRuleError'
  }
}

/** A method of Vortomi a company may pay with, with what it needs to pay there. */
export interface PayableMethod {
  id: string
  type: PaymentMethodType
  name: string
  currency: SubscriptionPaymentCurrency
  fields: PaymentField[]
  instructions: string
  referenceRule: PaymentProofRule
  receiptRule: PaymentProofRule
}

export interface PaymentView {
  id: string
  status: SubscriptionPaymentStatus
  months: number
  methodId: string | null
  methodName: string
  methodType: string
  currency: SubscriptionPaymentCurrency
  payer: PayerDetails
  reference: string | null
  paidOn: string
  amount: string
  bsPerUsd: string | null
  amountUsdCents: number
  hasProof: boolean
  rejectionReason: string | null
  rejectionNote: string | null
  submittedAt: Date
  reviewedAt: Date | null
}

const VIEW = {
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
}

/** The payment in review of a company, if any: it may keep the company out of suspension. */
export async function paymentInReview(executor: Executor, tenantId: string): Promise<PaymentView | null> {
  const [row] = await executor
    .select(VIEW)
    .from(subscriptionPayments)
    .where(and(eq(subscriptionPayments.tenantId, tenantId), eq(subscriptionPayments.status, 'in_review')))
  return row ?? null
}

/**
 * The payments a company reports to Vortomi (documentations/18 §5; mockups web-39 and web-40). Each
 * goes through its method's form, within the last 7 days, one in review at a time; a rejected one is
 * corrected and sent again. The console reviews them (stage 4). Written as the platform: the routes
 * prove first that the person is the company's owner or admin.
 */
export class SubscriptionPaymentService {
  constructor(
    private readonly db: Database,
    private readonly proofs: PaymentProofStore | null,
    private readonly today: () => string = () => caracasToday(),
  ) {}

  /** Vortomi's visible methods a company may pay with, in the console's order. */
  async methods(): Promise<PayableMethod[]> {
    const rows = await this.db
      .select({
        id: platformPaymentMethods.id,
        type: platformPaymentMethods.type,
        name: platformPaymentMethods.name,
        fields: platformPaymentMethods.fields,
        instructions: platformPaymentMethods.instructions,
        referenceRule: platformPaymentMethods.referenceRule,
        receiptRule: platformPaymentMethods.receiptRule,
      })
      .from(platformPaymentMethods)
      .where(eq(platformPaymentMethods.isActive, true))
      .orderBy(asc(platformPaymentMethods.sortOrder), asc(platformPaymentMethods.name))
    return rows.filter((m) => payableType(m.type)).map((m) => ({ ...m, currency: paymentCurrency(m.type) }))
  }

  /** Newest first. */
  list(tenantId: string): Promise<PaymentView[]> {
    return this.db.select(VIEW).from(subscriptionPayments).where(eq(subscriptionPayments.tenantId, tenantId)).orderBy(desc(subscriptionPayments.submittedAt))
  }

  async report(tenantId: string, userId: string, input: ReportPaymentInput): Promise<PaymentView> {
    const id = randomUUID()
    const checked = await this.check(input)
    const proofKey = checked.proof ? await this.storeProof(tenantId, id, checked.proof) : null
    if (!proofKey && checked.receiptRule === 'required') throw new PaymentRuleError('proof_required', 422)
    // The receipt is kept first: a payment row never points to a file that is not there. A failed
    // insert leaves an unused file under a key nothing will reuse.
    await this.db.transaction(async (tx) => {
      const chargeId = await this.openChargeFor(tx, tenantId, input.months)
      await tx.insert(subscriptionPayments).values({
        id,
        tenantId,
        chargeId,
        ...checked.values,
        proofKey,
        proofMimeType: checked.proof?.mimeType ?? null,
        proofSizeBytes: checked.proof?.bytes.length ?? null,
        submittedBy: userId,
      })
    })
    return (await this.find(tenantId, id))!
  }

  /** A rejected payment, corrected and sent again: in review once more. Its receipt stays unless a new one comes. */
  async resubmit(tenantId: string, paymentId: string, userId: string, input: ReportPaymentInput): Promise<PaymentView> {
    const [current] = await this.db
      .select({ status: subscriptionPayments.status, proofKey: subscriptionPayments.proofKey })
      .from(subscriptionPayments)
      .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId)))
    if (!current) throw new PaymentRuleError('payment_not_found', 404)
    if (current.status !== 'rejected') throw new PaymentRuleError('payment_not_editable', 409)
    const checked = await this.check(input)
    const proofKey = checked.proof ? await this.storeProof(tenantId, paymentId, checked.proof) : current.proofKey
    if (!proofKey && checked.receiptRule === 'required') throw new PaymentRuleError('proof_required', 422)
    await this.db.transaction(async (tx) => {
      const chargeId = await this.openChargeFor(tx, tenantId, input.months)
      const proof = checked.proof ? { proofMimeType: checked.proof.mimeType, proofSizeBytes: checked.proof.bytes.length } : {}
      await tx
        .update(subscriptionPayments)
        .set({
          chargeId,
          ...checked.values,
          proofKey,
          ...proof,
          status: 'in_review',
          rejectionReason: null,
          rejectionNote: null,
          reviewedBy: null,
          reviewedAt: null,
          submittedBy: userId,
          submittedAt: sql`now()`,
        })
        .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.status, 'rejected')))
    })
    return (await this.find(tenantId, paymentId))!
  }

  /** The receipt of one of the company's payments. */
  async proof(tenantId: string, paymentId: string): Promise<MediaFile> {
    const [row] = await this.db
      .select({ key: subscriptionPayments.proofKey })
      .from(subscriptionPayments)
      .where(and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId)))
    if (!row?.key) throw new PaymentRuleError('payment_not_found', 404)
    if (!this.proofs) throw new PaymentRuleError('proof_store_unavailable', 503)
    return this.proofs.get(row.key)
  }

  private async find(tenantId: string, id: string): Promise<PaymentView | null> {
    const [row] = await this.db.select(VIEW).from(subscriptionPayments).where(and(eq(subscriptionPayments.id, id), eq(subscriptionPayments.tenantId, tenantId)))
    return row ?? null
  }

  /** Everything about a payment that does not need the company's charge: its method, form, date and amount. */
  private async check(input: ReportPaymentInput) {
    const [method] = await this.db
      .select({ name: platformPaymentMethods.name, type: platformPaymentMethods.type, referenceRule: platformPaymentMethods.referenceRule, receiptRule: platformPaymentMethods.receiptRule })
      .from(platformPaymentMethods)
      .where(and(eq(platformPaymentMethods.id, input.methodId), eq(platformPaymentMethods.isActive, true)))
    if (!method || !payableType(method.type)) throw new PaymentRuleError('method_unavailable', 422)
    const { payer, reference } = checkPayer(method, input.payer, input.reference)
    const today = this.today()
    if (input.paidOn > today) throw new PaymentRuleError('payment_date_future', 422)
    if (input.paidOn < addDays(today, -REPORT_WINDOW_DAYS)) throw new PaymentRuleError('payment_date_too_old', 422)
    const currency = paymentCurrency(method.type)
    const bsPerUsd = currency === 'VES' ? await this.rateOn(input.paidOn) : null
    return {
      receiptRule: method.receiptRule,
      proof: input.proof ? readProof(input.proof) : null,
      values: {
        months: input.months,
        methodId: input.methodId,
        methodName: method.name,
        methodType: method.type,
        currency,
        payer,
        reference,
        paidOn: input.paidOn,
        amount: input.amount,
        bsPerUsd,
        amountUsdCents: toUsdCents(input.amount, currency, bsPerUsd),
      },
    }
  }

  /** Vortomi's rate in force on the payment day (the latest one set on or before it). */
  private async rateOn(day: string): Promise<string> {
    const [rate] = await this.db
      .select({ rate: platformExchangeRates.rate })
      .from(platformExchangeRates)
      .where(lte(platformExchangeRates.effectiveDate, day))
      .orderBy(desc(platformExchangeRates.effectiveDate), desc(platformExchangeRates.createdAt))
      .limit(1)
    if (!rate) throw new PaymentRuleError('rate_missing', 422)
    return rate.rate
  }

  private async storeProof(tenantId: string, paymentId: string, proof: { bytes: Buffer; mimeType: ProofInput['mimeType'] }): Promise<string> {
    if (!this.proofs) throw new PaymentRuleError('proof_store_unavailable', 503)
    const key = `${tenantId}/${paymentId}`
    await this.proofs.put(key, { bytes: proof.bytes, mimeType: proof.mimeType })
    return key
  }

  /**
   * The charge a payment goes to: the oldest one not paid in full, its months set to the ones chosen
   * while nothing of it is paid yet. With nothing owed, none: the payment pays the next period in
   * advance (documentations/18: full, it moves the date; partial, it goes to the wallet).
   */
  private async openChargeFor(tx: Executor, tenantId: string, months: number): Promise<string | null> {
    const [subscription] = await tx.select({ id: companySubscriptions.tenantId }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, tenantId))
    if (!subscription) throw new PaymentRuleError('no_subscription', 409)
    const [charge] = await tx
      .select({
        id: subscriptionCharges.id,
        months: subscriptionCharges.months,
        paidCents: subscriptionCharges.paidCents,
        basePriceCents: subscriptionCharges.basePriceCents,
        discounts: subscriptionCharges.discounts,
      })
      .from(subscriptionCharges)
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`))
      .orderBy(asc(subscriptionCharges.dueOn), asc(subscriptionCharges.createdAt))
      .limit(1)
    if (!charge) return null
    if (charge.months !== months) {
      if (charge.paidCents > 0) throw new PaymentRuleError('months_fixed', 409)
      const { discountPercent, amountCents } = chargeFor(charge.basePriceCents, charge.discounts, months)
      await tx.update(subscriptionCharges).set({ months, discountPercent, amountCents }).where(eq(subscriptionCharges.id, charge.id))
    }
    return charge.id
  }
}

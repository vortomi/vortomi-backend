import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { companyExemptions, companySubscriptions, companyTrials, platformExchangeRates, platformPlans, subscriptionCharges, subscriptionPayments, tenants } from '../../db/schema/index.ts'
import { type PaymentView, paymentInReview } from './subscription-payment-service.ts'
import { walletBalance } from './wallet.ts'
import { ExemptionRuleError, exemptionOf } from './subscription-exemptions.ts'
import type { ExemptionReason } from '../../db/schema/subscription-exemptions.ts'
import type { ChargeDiscounts, SUBSCRIPTION_ORIGINS } from '../../db/schema/subscriptions.ts'
import type { PlanSubscribers } from '../platform/platform-plans.ts'
import { billingEnforced } from './billing-enforcement.ts'
import { type BillingFacts, type BillingState, type Exemption, addDays, billingState, caracasToday, chargeFor, dueAfterExemption, exemptOn, suspendsOn, trialEndsOn, trialOver } from './subscription-rules.ts'

export const assignPlanInput = z.object({ planId: z.uuid() })
/** The company's own choice (Suscripción → Planes): the plan and the months it means to pay (1 by default). */
export const choosePlanInput = z.object({
  planId: z.uuid(),
  months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).default(1),
})

export type SubscriptionOrigin = (typeof SUBSCRIPTION_ORIGINS)[number]

/** The company already has a plan: changing it is a later stage (documentations/18, §8). */
export class SubscriptionExistsError extends Error {
  constructor() {
    super('The company already has a plan')
    this.name = 'SubscriptionExistsError'
  }
}

/** The plan does not exist or is suspended: nobody new may be put on it. */
export class PlanUnavailableError extends Error {
  constructor() {
    super('The plan is not available')
    this.name = 'PlanUnavailableError'
  }
}

export class CompanyNotFoundError extends Error {
  constructor() {
    super('Company not found')
    this.name = 'CompanyNotFoundError'
  }
}

export interface ChargeView {
  id: string
  planName: string
  basePriceCents: number
  discounts: ChargeDiscounts
  months: number
  discountPercent: number
  amountCents: number
  paidCents: number
  dueOn: string
}

/** What the company's Suscripción and the console's company page show (mockup web-37). */
export interface SubscriptionView {
  state: BillingState
  /** Whether an unpaid company is really locked out today (BILLING_ENFORCEMENT). */
  enforced: boolean
  plan: { id: string; name: string; description: string; priceCents: number; discounts: ChargeDiscounts; benefits: string[] }
  assignedAt: Date
  /** Chosen by the company, or assigned by the console as an exception. */
  origin: SubscriptionOrigin
  billingDay: number | null
  nextDueOn: string
  suspendsOn: string
  owedCents: number
  /** The charge being paid now; null when nothing is owed. */
  charge: ChargeView | null
  /** Vortomi's exchange rate for the bolívares, or null while it has none. */
  rate: { bsPerUsd: string; effectiveDate: string } | null
  /** The payment the console is reviewing, if any. */
  inReview: PaymentView | null
  /** The balance in favour, in dollar cents: taken from the next charge when it is made. */
  walletCents: number
}

/** What the company's Suscripción reads: its subscription, or its trial while it has none. */
export interface CompanySubscriptionView {
  subscription: SubscriptionView | null
  /** The last day of its trial; null for a company that never had one. */
  trialEndsOn: string | null
  /** Its exemption from paying while it lasts (mockup web-49): only until when, never why. */
  exemption: Exemption | null
  enforced: boolean
  rate: SubscriptionView['rate']
}

/** A row of Suscripciones → Cobros: every company, with or without a plan. */
export interface SubscriptionRow {
  tenantId: string
  tenantName: string
  planName: string | null
  billingDay: number | null
  nextDueOn: string | null
  suspendsOn: string | null
  owedCents: number
  /** 'none': no plan yet (and not exempt). */
  state: BillingState | 'none'
  /** Its exemption while it lasts. */
  exemption: { reason: ExemptionReason; endsOn: string | null } | null
}

const CHARGE_COLUMNS = {
  id: subscriptionCharges.id,
  planName: subscriptionCharges.planName,
  basePriceCents: subscriptionCharges.basePriceCents,
  discounts: subscriptionCharges.discounts,
  months: subscriptionCharges.months,
  discountPercent: subscriptionCharges.discountPercent,
  amountCents: subscriptionCharges.amountCents,
  paidCents: subscriptionCharges.paidCents,
  dueOn: subscriptionCharges.dueOn,
}

/**
 * A company's billing facts, read with any executor: the platform's connection, or the company's
 * own transaction (it may read its own rows: migration 0076). Null without a plan.
 */
export async function billingFactsOf(executor: Executor, tenantId: string): Promise<BillingFacts | null> {
  const [subscription] = await executor
    .select({ billingDay: companySubscriptions.billingDay, nextDueOn: companySubscriptions.nextDueOn })
    .from(companySubscriptions)
    .where(eq(companySubscriptions.tenantId, tenantId))
  if (!subscription) return null
  const [owed] = await executor
    .select({ cents: sql<number>`coalesce(sum(${subscriptionCharges.amountCents} - ${subscriptionCharges.paidCents}), 0)::int` })
    .from(subscriptionCharges)
    .where(eq(subscriptionCharges.tenantId, tenantId))
  const [review] = await executor
    .select({ cents: subscriptionPayments.amountUsdCents })
    .from(subscriptionPayments)
    .where(and(eq(subscriptionPayments.tenantId, tenantId), eq(subscriptionPayments.status, 'in_review')))
  const exemption = await exemptionOf(executor, tenantId)
  return {
    billingDay: subscription.billingDay,
    nextDueOn: dueAfterExemption(subscription.nextDueOn, exemption),
    owedCents: owed?.cents ?? 0,
    reviewCents: review?.cents ?? 0,
    exemption,
  }
}

/**
 * Whether a company is suspended right now (only while the rule is enforced): with a plan, for not
 * paying; without one, once its trial is over. A company with neither is left alone.
 */
export async function unpaidAndSuspended(executor: Executor, tenantId: string, today = caracasToday()): Promise<boolean> {
  if (!billingEnforced()) return false
  const facts = await billingFactsOf(executor, tenantId)
  if (facts) return billingState(facts, today) === 'suspended'
  if (exemptOn(await exemptionOf(executor, tenantId), today)) return false
  const endsOn = await trialEndOf(executor, tenantId)
  return endsOn !== null && trialOver(endsOn, today)
}

async function trialEndOf(executor: Executor, tenantId: string): Promise<string | null> {
  const [trial] = await executor.select({ endsOn: companyTrials.endsOn }).from(companyTrials).where(eq(companyTrials.tenantId, tenantId))
  return trial?.endsOn ?? null
}

/**
 * A company that goes live gets its days to choose a plan, counted from today. Only the first time:
 * a company suspended and live again keeps the trial it had.
 */
export async function startTrial(executor: Executor, tenantId: string, today = caracasToday()): Promise<void> {
  await executor.insert(companyTrials).values({ tenantId, endsOn: trialEndsOn(today) }).onConflictDoNothing()
}

/**
 * Vortomi's subscriptions (documentations/18, stage 2): the console assigns a plan, which makes the
 * first charge (1 month, due that day); the company sees what it owes. Payments come in stages 3–4.
 */
export class SubscriptionService {
  constructor(
    private readonly db: Database,
    private readonly today: () => string = () => caracasToday(),
  ) {}

  /**
   * The plan and its first charge, due today, in one transaction. Only an active plan, only once.
   * The company chooses it itself (with the months it means to pay); the console may assign it as an
   * exception (1 month). Either way the company has until its suspension date to pay.
   */
  async assign(tenantId: string, planId: string, assignedBy: string, choice: { months?: number; origin?: SubscriptionOrigin } = {}): Promise<SubscriptionView> {
    const months = choice.months ?? 1
    await this.db.transaction(async (tx) => {
      const [company] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), ne(tenants.status, 'draft')))
      if (!company) throw new CompanyNotFoundError()
      const [plan] = await tx.select().from(platformPlans).where(eq(platformPlans.id, planId))
      if (!plan?.isActive) throw new PlanUnavailableError()
      const today = this.today()
      const dueOn = await this.firstDueOn(tx, tenantId, today)
      const inserted = await tx
        .insert(companySubscriptions)
        .values({ tenantId, planId, assignedBy, origin: choice.origin ?? 'console', nextDueOn: dueOn })
        .onConflictDoNothing()
        .returning({ tenantId: companySubscriptions.tenantId })
      if (!inserted.length) throw new SubscriptionExistsError()
      const discounts = { '1': plan.discount1, '3': plan.discount3, '6': plan.discount6, '12': plan.discount12 }
      const { discountPercent, amountCents } = chargeFor(plan.priceCents, discounts, months)
      await tx.insert(subscriptionCharges).values({
        tenantId,
        planId,
        planName: plan.name,
        basePriceCents: plan.priceCents,
        discounts,
        months,
        discountPercent,
        amountCents,
        dueOn,
      })
    })
    return (await this.view(tenantId))!
  }

  /**
   * A plan's first charge is due the day it is chosen; for a company exempt until a day, the day
   * after it. One exempt with no end has nothing to choose (documentations/18 §8).
   */
  private async firstDueOn(tx: Executor, tenantId: string, today: string): Promise<string> {
    const exemption = await exemptionOf(tx, tenantId)
    if (!exemptOn(exemption, today)) return today
    if (exemption!.endsOn === null) throw new ExemptionRuleError('company_exempt', 409)
    return addDays(exemption!.endsOn, 1)
  }

  /** The company's subscription as its panel and the console show it; null without a plan. */
  async view(tenantId: string): Promise<SubscriptionView | null> {
    const [row] = await this.db
      .select({
        planId: platformPlans.id,
        name: platformPlans.name,
        description: platformPlans.description,
        priceCents: platformPlans.priceCents,
        discount1: platformPlans.discount1,
        discount3: platformPlans.discount3,
        discount6: platformPlans.discount6,
        discount12: platformPlans.discount12,
        benefits: platformPlans.benefits,
        assignedAt: companySubscriptions.assignedAt,
        origin: companySubscriptions.origin,
        billingDay: companySubscriptions.billingDay,
        nextDueOn: companySubscriptions.nextDueOn,
      })
      .from(companySubscriptions)
      .innerJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
      .where(eq(companySubscriptions.tenantId, tenantId))
    if (!row) return null
    const facts = (await billingFactsOf(this.db, tenantId))!
    // The oldest charge not paid in full is the one being paid now.
    const [charge] = await this.db
      .select(CHARGE_COLUMNS)
      .from(subscriptionCharges)
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`))
      .orderBy(asc(subscriptionCharges.dueOn), asc(subscriptionCharges.createdAt))
      .limit(1)
    const rate = await this.rate()
    return {
      state: billingState(facts, this.today()),
      enforced: billingEnforced(),
      plan: {
        id: row.planId,
        name: row.name,
        description: row.description,
        priceCents: row.priceCents,
        discounts: { '1': row.discount1, '3': row.discount3, '6': row.discount6, '12': row.discount12 },
        benefits: row.benefits,
      },
      assignedAt: row.assignedAt,
      origin: row.origin,
      billingDay: row.billingDay,
      nextDueOn: facts.nextDueOn,
      suspendsOn: suspendsOn(facts.nextDueOn),
      owedCents: facts.owedCents,
      charge: charge ?? null,
      rate,
      inReview: await paymentInReview(this.db, tenantId),
      walletCents: await walletBalance(this.db, tenantId),
    }
  }

  /** The company's Suscripción: its subscription, its trial while it has none, and Vortomi's rate. */
  async companyView(tenantId: string): Promise<CompanySubscriptionView> {
    const subscription = await this.view(tenantId)
    return {
      subscription,
      trialEndsOn: await trialEndOf(this.db, tenantId),
      exemption: await this.currentExemption(tenantId),
      enforced: billingEnforced(),
      rate: subscription ? subscription.rate : await this.rate(),
    }
  }

  private async currentExemption(tenantId: string): Promise<Exemption | null> {
    const exemption = await exemptionOf(this.db, tenantId)
    return exemptOn(exemption, this.today()) ? { endsOn: exemption!.endsOn } : null
  }

  /** Vortomi's latest exchange rate, for the bolívares; null while it has none. */
  private async rate(): Promise<SubscriptionView['rate']> {
    const [rate] = await this.db
      .select({ bsPerUsd: platformExchangeRates.rate, effectiveDate: platformExchangeRates.effectiveDate })
      .from(platformExchangeRates)
      .orderBy(desc(platformExchangeRates.createdAt))
      .limit(1)
    return rate ?? null
  }

  /** Suscripciones → Cobros: every company that is past its draft, with its plan or without one. */
  async list(): Promise<SubscriptionRow[]> {
    const rows = await this.db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        planName: platformPlans.name,
        billingDay: companySubscriptions.billingDay,
        nextDueOn: companySubscriptions.nextDueOn,
        owedCents: sql<number>`coalesce((select sum(c.amount_cents - c.paid_cents) from subscription_charges c where c.company_id = ${tenants.id}), 0)::int`,
        reviewCents: sql<number>`coalesce((select p.amount_usd_cents from subscription_payments p where p.company_id = ${tenants.id} and p.status = 'in_review'), 0)::int`,
        exemptReason: companyExemptions.reason,
        exemptEndsOn: companyExemptions.endsOn,
      })
      .from(tenants)
      .leftJoin(companySubscriptions, eq(companySubscriptions.tenantId, tenants.id))
      .leftJoin(companyExemptions, eq(companyExemptions.tenantId, tenants.id))
      .leftJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
      .where(ne(tenants.status, 'draft'))
      .orderBy(asc(tenants.name))
    const today = this.today()
    return rows.map((r) => {
      const exemption = r.exemptReason ? { reason: r.exemptReason, endsOn: r.exemptEndsOn } : null
      const exempt = exemptOn(exemption, today)
      const nextDueOn = r.nextDueOn ? dueAfterExemption(r.nextDueOn, exemption) : null
      const facts = nextDueOn ? { billingDay: r.billingDay, nextDueOn, owedCents: r.owedCents, reviewCents: r.reviewCents, exemption } : null
      return {
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        planName: r.planName,
        billingDay: r.billingDay,
        nextDueOn,
        suspendsOn: nextDueOn ? suspendsOn(nextDueOn) : null,
        owedCents: r.owedCents,
        state: exempt ? 'exempt' : facts ? billingState(facts, today) : 'none',
        exemption: exempt ? exemption : null,
      }
    })
  }
}

/** How many companies are on each plan, for Planes (delete only a plan nobody has). */
export class SubscriptionCounts implements PlanSubscribers {
  constructor(private readonly db: Database) {}

  async count(planIds: string[]): Promise<Map<string, number>> {
    if (!planIds.length) return new Map()
    const rows = await this.db
      .select({ planId: companySubscriptions.planId, n: sql<number>`count(*)::int` })
      .from(companySubscriptions)
      .where(inArray(companySubscriptions.planId, planIds))
      .groupBy(companySubscriptions.planId)
    return new Map(rows.map((r) => [r.planId, r.n]))
  }
}

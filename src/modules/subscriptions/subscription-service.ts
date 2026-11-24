import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { companySubscriptions, platformExchangeRates, platformPlans, subscriptionCharges, tenants } from '../../db/schema/index.ts'
import type { ChargeDiscounts } from '../../db/schema/subscriptions.ts'
import type { PlanSubscribers } from '../platform/platform-plans.ts'
import { billingEnforced } from './billing-enforcement.ts'
import { type BillingFacts, type BillingState, billingState, caracasToday, suspendsOn } from './subscription-rules.ts'

export const assignPlanInput = z.object({ planId: z.uuid() })

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
  billingDay: number | null
  nextDueOn: string
  suspendsOn: string
  owedCents: number
  /** The charge being paid now; null when nothing is owed. */
  charge: ChargeView | null
  /** Vortomi's exchange rate for the bolívares, or null while it has none. */
  rate: { bsPerUsd: string; effectiveDate: string } | null
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
  /** 'none': no plan yet. */
  state: BillingState | 'none'
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
  return { ...subscription, owedCents: owed?.cents ?? 0 }
}

/** Whether a company is suspended for not paying, right now (only while the rule is enforced). */
export async function unpaidAndSuspended(executor: Executor, tenantId: string, today = caracasToday()): Promise<boolean> {
  if (!billingEnforced()) return false
  const facts = await billingFactsOf(executor, tenantId)
  return facts !== null && billingState(facts, today) === 'suspended'
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

  /** The plan and its first charge, in one transaction. Only an active plan, only once. */
  async assign(tenantId: string, planId: string, assignedBy: string): Promise<SubscriptionView> {
    await this.db.transaction(async (tx) => {
      const [company] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), ne(tenants.status, 'draft')))
      if (!company) throw new CompanyNotFoundError()
      const [plan] = await tx.select().from(platformPlans).where(eq(platformPlans.id, planId))
      if (!plan?.isActive) throw new PlanUnavailableError()
      const today = this.today()
      const inserted = await tx
        .insert(companySubscriptions)
        .values({ tenantId, planId, assignedBy, nextDueOn: today })
        .onConflictDoNothing()
        .returning({ tenantId: companySubscriptions.tenantId })
      if (!inserted.length) throw new SubscriptionExistsError()
      await tx.insert(subscriptionCharges).values({
        tenantId,
        planId,
        planName: plan.name,
        basePriceCents: plan.priceCents,
        discounts: { '1': plan.discount1, '3': plan.discount3, '6': plan.discount6, '12': plan.discount12 },
        months: 1,
        discountPercent: plan.discount1,
        amountCents: Math.round((plan.priceCents * (100 - plan.discount1)) / 100),
        dueOn: today,
      })
    })
    return (await this.view(tenantId))!
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
    const [rate] = await this.db
      .select({ bsPerUsd: platformExchangeRates.rate, effectiveDate: platformExchangeRates.effectiveDate })
      .from(platformExchangeRates)
      .orderBy(desc(platformExchangeRates.createdAt))
      .limit(1)
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
      billingDay: row.billingDay,
      nextDueOn: row.nextDueOn,
      suspendsOn: suspendsOn(row.nextDueOn),
      owedCents: facts.owedCents,
      charge: charge ?? null,
      rate: rate ?? null,
    }
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
      })
      .from(tenants)
      .leftJoin(companySubscriptions, eq(companySubscriptions.tenantId, tenants.id))
      .leftJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
      .where(ne(tenants.status, 'draft'))
      .orderBy(asc(tenants.name))
    const today = this.today()
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      planName: r.planName,
      billingDay: r.billingDay,
      nextDueOn: r.nextDueOn,
      suspendsOn: r.nextDueOn ? suspendsOn(r.nextDueOn) : null,
      owedCents: r.owedCents,
      state: r.nextDueOn ? billingState({ billingDay: r.billingDay, nextDueOn: r.nextDueOn, owedCents: r.owedCents }, today) : 'none',
    }))
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

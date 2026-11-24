import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database, Executor } from '../../db/client.ts'
import { companySubscriptions, platformPlans, subscriptionCharges, walletMovements } from '../../db/schema/index.ts'
import { addMonthsOn, caracasToday, chargeFor, dayOfMonth, dueAfterExemption, exemptOn } from './subscription-rules.ts'
import { exemptionOf } from './subscription-exemptions.ts'
import { walletBalance } from './wallet.ts'

/** A company never gets more than this many months charged in one run (a guard, not a rule). */
const MAX_MONTHS_PER_RUN = 24

/**
 * The monthly charge is made when the month falls due (decided 24/11/2026): on the due day, a
 * company that already paid its first month and has nothing open gets its next charge (1 month, the
 * plan's price that day), and its balance in favour is taken from it right then. A balance that
 * covers it whole pays it, and the next month is looked at too. Safe to run as often as wanted.
 *
 * An exempt company is never charged (mockup web-49). Once its exemption is over it pays from the
 * day after its last exempt day, which becomes its billing day; one that never paid its first month
 * gets that first charge then (1 month: the months stay its choice until something is paid).
 */
export class SubscriptionBillingJob {
  constructor(
    private readonly db: Database,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'error'>,
    private readonly today: () => string = () => caracasToday(),
  ) {}

  /** How many charges were made. */
  async run(): Promise<number> {
    const today = this.today()
    const due = await this.db
      .select({ tenantId: companySubscriptions.tenantId })
      .from(companySubscriptions)
      .where(lte(companySubscriptions.nextDueOn, today))
    let made = 0
    for (const { tenantId } of due) {
      try {
        made += await this.chargeDue(tenantId, today)
      } catch (error) {
        this.log.error({ err: error, tenantId }, 'Monthly charge could not be made')
      }
    }
    if (made) this.log.info({ charges: made }, 'Monthly subscription charges made')
    return made
  }

  private chargeDue(tenantId: string, today: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      // The subscription is locked: an approval at the same moment waits for this one.
      const [sub] = await tx
        .select({ planId: companySubscriptions.planId, billingDay: companySubscriptions.billingDay, nextDueOn: companySubscriptions.nextDueOn })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.tenantId, tenantId))
        .for('update')
      if (!sub) return 0
      const exemption = await exemptionOf(tx, tenantId)
      if (exemptOn(exemption, today)) return 0
      let { billingDay, nextDueOn } = sub
      // Just out of an exemption: due the day after it, on that day of every month.
      const afterExemption = dueAfterExemption(nextDueOn, exemption)
      if (afterExemption !== nextDueOn) {
        nextDueOn = afterExemption
        billingDay = billingDay === null ? null : dayOfMonth(nextDueOn)
        await tx.update(companySubscriptions).set({ nextDueOn, billingDay, updatedAt: sql`now()` }).where(eq(companySubscriptions.tenantId, tenantId))
        if (nextDueOn > today) return 0
      }
      if (billingDay === null) return this.firstCharge(tx, tenantId, sub.planId, nextDueOn)
      let made = 0
      while (nextDueOn <= today && made < MAX_MONTHS_PER_RUN) {
        // Something still open, or this very month already charged: nothing to make.
        const [open] = await tx
          .select({ id: subscriptionCharges.id })
          .from(subscriptionCharges)
          .where(
            and(
              eq(subscriptionCharges.tenantId, tenantId),
              sql`(${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents} or ${subscriptionCharges.dueOn} = ${nextDueOn})`,
            ),
          )
          .orderBy(asc(subscriptionCharges.dueOn))
          .limit(1)
        if (open) break
        const [plan] = await tx.select().from(platformPlans).where(eq(platformPlans.id, sub.planId))
        if (!plan) break
        const discounts = { '1': plan.discount1, '3': plan.discount3, '6': plan.discount6, '12': plan.discount12 }
        const { discountPercent, amountCents } = chargeFor(plan.priceCents, discounts, 1)
        const balance = await walletBalance(tx, tenantId)
        const fromWallet = Math.min(balance, amountCents)
        const [charge] = await tx
          .insert(subscriptionCharges)
          .values({
            tenantId,
            planId: plan.id,
            planName: plan.name,
            basePriceCents: plan.priceCents,
            discounts,
            months: 1,
            discountPercent,
            amountCents,
            dueOn: nextDueOn,
            paidCents: fromWallet,
            paidAt: fromWallet === amountCents ? sql`now()` : null,
          })
          .returning({ id: subscriptionCharges.id })
        if (fromWallet > 0) await tx.insert(walletMovements).values({ tenantId, kind: 'applied', amountCents: -fromWallet, chargeId: charge!.id })
        made++
        // Paid whole by the balance: the month is covered and the next one is looked at.
        if (fromWallet < amountCents) break
        nextDueOn = addMonthsOn(nextDueOn, 1, billingDay)
        await tx.update(companySubscriptions).set({ nextDueOn, updatedAt: sql`now()` }).where(eq(companySubscriptions.tenantId, tenantId))
      }
      return made
    })
  }

  /** A first month for a company whose first charge an exemption forgave: none if one is open. */
  private async firstCharge(tx: Executor, tenantId: string, planId: string, dueOn: string): Promise<number> {
    const [open] = await tx
      .select({ id: subscriptionCharges.id })
      .from(subscriptionCharges)
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`))
      .limit(1)
    if (open) return 0
    const [plan] = await tx.select().from(platformPlans).where(eq(platformPlans.id, planId))
    if (!plan) return 0
    const discounts = { '1': plan.discount1, '3': plan.discount3, '6': plan.discount6, '12': plan.discount12 }
    const { discountPercent, amountCents } = chargeFor(plan.priceCents, discounts, 1)
    await tx.insert(subscriptionCharges).values({ tenantId, planId: plan.id, planName: plan.name, basePriceCents: plan.priceCents, discounts, months: 1, discountPercent, amountCents, dueOn })
    return 1
  }
}


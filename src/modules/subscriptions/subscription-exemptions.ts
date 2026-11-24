import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { companyExemptions, companySubscriptions, subscriptionCharges, subscriptionPayments, tenants, users } from '../../db/schema/index.ts'
import { EXEMPTION_REASONS, type ExemptionReason } from '../../db/schema/subscription-exemptions.ts'
import { type Exemption, addDays, caracasToday, exemptOn } from './subscription-rules.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** «Exonerar del pago» (mockup web-49): a reason from the list, an optional note, and until when. */
export const exemptionInput = z
  .object({
    reason: z.enum(EXEMPTION_REASONS),
    note: z
      .string()
      .trim()
      .max(300)
      .nullish()
      .transform((v) => v || null),
    // The last exempt day; null: no end.
    endsOn: z.string().regex(DAY).nullable(),
  })
  .refine((v) => v.reason !== 'other' || v.note !== null, { message: 'A note is needed for «other»', path: ['note'] })

export type ExemptionInput = z.infer<typeof exemptionInput>

/** Removing an exemption ends it this many days later: the company gets the warning a trial gives. */
export const EXEMPTION_NOTICE_DAYS = 7

/** An exemption that breaks a rule, with the code the panel explains. */
export class ExemptionRuleError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(`Exemption rule: ${code}`)
    this.name = 'ExemptionRuleError'
  }
}

/** What the console sees: everything, while the exemption lasts. */
export interface ExemptionView {
  reason: ExemptionReason
  note: string | null
  endsOn: string | null
  forgivenCents: number
  grantedAt: Date
  grantedByName: string | null
}

/**
 * The company's latest exemption, read with any executor (the company's own may read only its last
 * day: migration 0080). Null if it never had one.
 */
export async function exemptionOf(executor: Executor, tenantId: string): Promise<Exemption | null> {
  const [row] = await executor.select({ endsOn: companyExemptions.endsOn }).from(companyExemptions).where(eq(companyExemptions.tenantId, tenantId))
  return row ?? null
}

/**
 * Vortomi exempts a company from paying (documentations/18 §8, mockup web-49). Exempting forgives
 * what it owes (a payment in review is decided first); a charge for after the exemption (a plan
 * chosen while exempt) moves to the day after it. Removing one never locks the company out that day:
 * it ends 7 days later, with the warning a trial gives.
 */
export class ExemptionService {
  constructor(
    private readonly db: Database,
    private readonly today: () => string = () => caracasToday(),
  ) {}

  /** The exemption that covers today, if any. */
  async view(tenantId: string): Promise<ExemptionView | null> {
    const [row] = await this.db
      .select({
        reason: companyExemptions.reason,
        note: companyExemptions.note,
        endsOn: companyExemptions.endsOn,
        forgivenCents: companyExemptions.forgivenCents,
        grantedAt: companyExemptions.grantedAt,
        grantedByName: users.name,
      })
      .from(companyExemptions)
      .leftJoin(users, eq(users.id, companyExemptions.grantedBy))
      .where(eq(companyExemptions.tenantId, tenantId))
    return row && exemptOn(row, this.today()) ? row : null
  }

  /** A new exemption: refused while one already covers today (that one is changed instead). */
  async grant(tenantId: string, input: ExemptionInput, grantedBy: string): Promise<ExemptionView> {
    const today = this.today()
    this.checkEnd(input.endsOn, today)
    await this.db.transaction(async (tx) => {
      const [company] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), sql`${tenants.status} <> 'draft'`))
      if (!company) throw new ExemptionRuleError('company_not_found', 404)
      const current = await this.locked(tx, tenantId)
      if (current && exemptOn(current, today)) throw new ExemptionRuleError('exemption_exists', 409)
      const forgivenCents = await this.settleCharges(tx, tenantId, input.endsOn, today)
      const values = { reason: input.reason, note: input.note, endsOn: input.endsOn, forgivenCents, grantedBy, grantedAt: sql`now()`, updatedAt: sql`now()` }
      await tx
        .insert(companyExemptions)
        .values({ tenantId, ...values })
        .onConflictDoUpdate({ target: companyExemptions.tenantId, set: values })
    })
    return (await this.view(tenantId))!
  }

  /** The reason, the note or the end of the exemption that covers today. */
  async change(tenantId: string, input: ExemptionInput): Promise<ExemptionView> {
    const today = this.today()
    this.checkEnd(input.endsOn, today)
    await this.db.transaction(async (tx) => {
      const current = await this.locked(tx, tenantId)
      if (!current || !exemptOn(current, today)) throw new ExemptionRuleError('exemption_not_found', 404)
      const forgivenCents = current.forgivenCents + (await this.settleCharges(tx, tenantId, input.endsOn, today))
      await tx
        .update(companyExemptions)
        .set({ reason: input.reason, note: input.note, endsOn: input.endsOn, forgivenCents, updatedAt: sql`now()` })
        .where(eq(companyExemptions.tenantId, tenantId))
    })
    return (await this.view(tenantId))!
  }

  /** Ends the exemption in 7 days (sooner only if it already ended sooner). */
  async remove(tenantId: string): Promise<ExemptionView> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const current = await this.locked(tx, tenantId)
      if (!current || !exemptOn(current, today)) throw new ExemptionRuleError('exemption_not_found', 404)
      const endsOn = addDays(today, EXEMPTION_NOTICE_DAYS)
      if (current.endsOn !== null && current.endsOn <= endsOn) return
      await this.moveLaterCharges(tx, tenantId, endsOn)
      await tx.update(companyExemptions).set({ endsOn, updatedAt: sql`now()` }).where(eq(companyExemptions.tenantId, tenantId))
    })
    return (await this.view(tenantId))!
  }

  private checkEnd(endsOn: string | null, today: string): void {
    if (endsOn !== null && (Number.isNaN(Date.parse(`${endsOn}T00:00:00Z`)) || endsOn < today)) throw new ExemptionRuleError('exemption_end_past', 422)
  }

  private async locked(tx: Executor, tenantId: string) {
    const [row] = await tx
      .select({ endsOn: companyExemptions.endsOn, forgivenCents: companyExemptions.forgivenCents })
      .from(companyExemptions)
      .where(eq(companyExemptions.tenantId, tenantId))
      .for('update')
    return row ?? null
  }

  /**
   * What is owed is forgiven: a charge due by today, and, with no end, any other open one. A charge
   * nothing was paid on goes away; one partly paid closes at what was paid. A charge due after the
   * exemption's end stays, moved to the day after it. Returns the cents forgiven.
   */
  private async settleCharges(tx: Executor, tenantId: string, endsOn: string | null, today: string): Promise<number> {
    const [review] = await tx
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(and(eq(subscriptionPayments.tenantId, tenantId), eq(subscriptionPayments.status, 'in_review')))
    if (review) throw new ExemptionRuleError('exemption_payment_in_review', 409)
    const open = await tx
      .select({ id: subscriptionCharges.id, amountCents: subscriptionCharges.amountCents, paidCents: subscriptionCharges.paidCents, dueOn: subscriptionCharges.dueOn })
      .from(subscriptionCharges)
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`))
      .for('update')
    let forgiven = 0
    for (const charge of open) {
      if (endsOn !== null && charge.dueOn > today) continue
      forgiven += charge.amountCents - charge.paidCents
      if (charge.paidCents === 0) await tx.delete(subscriptionCharges).where(eq(subscriptionCharges.id, charge.id))
      else await tx.update(subscriptionCharges).set({ amountCents: charge.paidCents, paidAt: sql`now()` }).where(eq(subscriptionCharges.id, charge.id))
    }
    if (endsOn !== null) await this.moveLaterCharges(tx, tenantId, endsOn)
    return forgiven
  }

  /**
   * A charge for after the exemption (a plan chosen while exempt: nothing else is due in the future)
   * is due the day after its last day, sooner or later; so is the first payment of such a plan.
   */
  private async moveLaterCharges(tx: Executor, tenantId: string, endsOn: string): Promise<void> {
    const dueOn = addDays(endsOn, 1)
    const today = this.today()
    await tx
      .update(subscriptionCharges)
      .set({ dueOn })
      .where(and(eq(subscriptionCharges.tenantId, tenantId), sql`${subscriptionCharges.paidCents} < ${subscriptionCharges.amountCents}`, gt(subscriptionCharges.dueOn, today)))
    await tx
      .update(companySubscriptions)
      .set({ nextDueOn: dueOn, updatedAt: sql`now()` })
      .where(and(eq(companySubscriptions.tenantId, tenantId), isNull(companySubscriptions.billingDay), gt(companySubscriptions.nextDueOn, today)))
  }
}

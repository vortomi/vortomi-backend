/**
 * The dates of a subscription (documentations/18). Every day is a Caracas calendar day,
 * "2026-12-05". A charge is due on its day; the next 2 days are grace; at 00:00 of the third day
 * after it, a company that still owes anything is suspended (due the 5th → suspended the 8th). The
 * first charge is due the day the plan is assigned, with the same grace (assigned the 1st →
 * suspended the 4th). Only paying the whole debt avoids it.
 */

/** Days after the due day that the company keeps working. */
export const GRACE_DAYS = 2
/** A charge due within these days shows as «Por vencer». */
export const SOON_DAYS = 7

export type BillingState = 'awaiting_first_payment' | 'active' | 'due_soon' | 'grace' | 'suspended'

const DAY_MS = 86_400_000

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** Today in Caracas. */
export function caracasToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(now)
}

/** The day a company that still owes is suspended, at 00:00 Caracas time. */
export const suspendsOn = (dueOn: string): string => addDays(dueOn, GRACE_DAYS + 1)

export interface BillingFacts {
  /** Null until the first payment. */
  billingDay: number | null
  nextDueOn: string
  /** What is still owed on the charges due so far and the one coming. */
  owedCents: number
}

export function billingState(facts: BillingFacts, today: string): BillingState {
  if (facts.owedCents <= 0) return 'active'
  if (today >= suspendsOn(facts.nextDueOn)) return 'suspended'
  if (facts.billingDay === null) return 'awaiting_first_payment'
  if (today > facts.nextDueOn) return 'grace'
  return daysBetween(today, facts.nextDueOn) < SOON_DAYS ? 'due_soon' : 'active'
}

/** A plan paid for `months`: its discount tier («from» 1, 3, 6 or 12) on the base price of every month. */
export function chargeFor(basePriceCents: number, discounts: Record<'1' | '3' | '6' | '12', number>, months: number) {
  const tier = months >= 12 ? '12' : months >= 6 ? '6' : months >= 3 ? '3' : '1'
  const discountPercent = discounts[tier] ?? 0
  const amountCents = Math.round((basePriceCents * months * (100 - discountPercent)) / 100)
  return { discountPercent, amountCents }
}

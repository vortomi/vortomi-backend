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

/**
 * 'in_review': a payment in review covers the whole debt; the company works as if it owed nothing
 * until the console decides (decided 24/11/2026). Rejected, the dates count again.
 * 'exempt': the console exempted it from paying (mockup web-49); nothing is charged meanwhile.
 */
export type BillingState = 'awaiting_first_payment' | 'active' | 'due_soon' | 'grace' | 'suspended' | 'in_review' | 'exempt'

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
  /** What the payment in review would pay, in dollar cents (0 without one). */
  reviewCents?: number
  /** The company's latest exemption from paying, if it ever had one. */
  exemption?: Exemption | null
}

/** An exemption from paying: its last exempt day, or null for one with no end. */
export interface Exemption {
  endsOn: string | null
}

/** Whether an exemption covers today. */
export const exemptOn = (exemption: Exemption | null | undefined, today: string): boolean =>
  !!exemption && (exemption.endsOn === null || today <= exemption.endsOn)

/**
 * The due day once an exemption is over: the day after its last one, unless the company had already
 * paid beyond it (decided 24/11/2026, mockup web-49).
 */
export const dueAfterExemption = (nextDueOn: string, exemption: Exemption | null | undefined): string =>
  exemption?.endsOn && nextDueOn <= exemption.endsOn ? addDays(exemption.endsOn, 1) : nextDueOn

export function billingState(facts: BillingFacts, today: string): BillingState {
  if (exemptOn(facts.exemption, today)) return 'exempt'
  // Nothing owed yet: the next charge is made on its due day, but the reminder starts 7 days before.
  if (facts.owedCents <= 0) return facts.billingDay !== null && daysBetween(today, facts.nextDueOn) < SOON_DAYS ? 'due_soon' : 'active'
  if ((facts.reviewCents ?? 0) >= facts.owedCents) return 'in_review'
  if (today >= suspendsOn(facts.nextDueOn)) return 'suspended'
  if (facts.billingDay === null) return 'awaiting_first_payment'
  if (today > facts.nextDueOn) return 'grace'
  return daysBetween(today, facts.nextDueOn) < SOON_DAYS ? 'due_soon' : 'active'
}

/** Days a live company may use Vortomi before choosing a plan, the day it goes live included. */
export const TRIAL_DAYS = 7

/** The last day of a trial that starts today. */
export const trialEndsOn = (startsOn: string): string => addDays(startsOn, TRIAL_DAYS - 1)

/** A company without a plan is suspended from 00:00 of the day after its trial's last day. */
export const trialOver = (endsOn: string, today: string): boolean => today > endsOn

/** A plan paid for `months`: its discount tier («from» 1, 3, 6 or 12) on the base price of every month. */
export function chargeFor(basePriceCents: number, discounts: Record<'1' | '3' | '6' | '12', number>, months: number) {
  const tier = months >= 12 ? '12' : months >= 6 ? '6' : months >= 3 ? '3' : '1'
  const discountPercent = discounts[tier] ?? 0
  const amountCents = Math.round((basePriceCents * months * (100 - discountPercent)) / 100)
  return { discountPercent, amountCents }
}

/**
 * The due day `months` after `day`, on the billing day: a billing day the month lacks falls on its
 * last day (31 → 28 in February), and comes back to 31 when the month has it (documentations/18 §2).
 */
export function addMonthsOn(day: string, months: number, billingDay: number): string {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7)) - 1 + months
  const first = new Date(Date.UTC(year, month, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(billingDay, last))
  return first.toISOString().slice(0, 10)
}

/** The day of the month a date falls on: the billing day set by a first payment. */
export const dayOfMonth = (day: string): number => Number(day.slice(8, 10))

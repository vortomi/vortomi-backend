import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import {
  companySubscriptions,
  companyTrials,
  platformPlans,
  subscriptionCharges,
  subscriptionPayments,
  subscriptionReceipts,
  tenants,
  walletMovements,
} from '../../db/schema/index.ts'
import type { SubscriptionRow, SubscriptionService } from './subscription-service.ts'
import { RECEIPT_NUMBER } from './subscription-payment-service.ts'
import { addDays, caracasToday, daysBetween } from './subscription-rules.ts'

/** The period Resumen looks at (mockup web-51): this month, this year, the last 12 months, or everything. */
export const SUMMARY_PERIODS = ['month', 'year', '12m', 'all'] as const
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number]
export const summaryQuery = z.object({ period: z.enum(SUMMARY_PERIODS).default('year') })

/** Days ahead «Vencen en los próximos 30 días» looks at. */
const UPCOMING_DAYS = 30
const RECENT_PAYMENTS = 5
/** Marks the file as UTF-8 for Excel (the accents). */
const BOM = String.fromCharCode(0xfeff)

/** What really arrived, in dollar cents: the amount approved (decided 24/11/2026, mockup web-51). */
const RECEIVED_USD = sql<number>`coalesce(${subscriptionPayments.receivedUsdCents}, ${subscriptionPayments.amountUsdCents})`
/** The same, in bolívares, for the payments made in bolívares. */
const RECEIVED_VES = sql<string>`coalesce(${subscriptionPayments.receivedAmount}, ${subscriptionPayments.amount})`
const approved = eq(subscriptionPayments.status, 'approved')

export interface IncomeBucket {
  /** "2026-11" (a month) or "2026-11-24" (a day of «Este mes»). */
  key: string
  cents: number
  count: number
}

export interface SubscriptionSummary {
  period: { id: SummaryPeriod; from: string; to: string }
  income: {
    thisMonthCents: number
    previousMonthCents: number
    periodCents: number
    /** What the payments made in bolívares came to, in bolívares ("1234.56"). */
    periodVes: string
    periodCount: number
    /** The first approved payment ever, if any. */
    firstPaidOn: string | null
  }
  /** What the plans paid today come to each month: each paying company's last charge over its months. */
  recurringCents: number
  owedCents: number
  overdueCents: number
  overdueCompanies: number
  companies: { upToDate: number; awaitingFirst: number; overdue: number; exempt: number; trial: number; noPlan: number }
  walletCents: number
  review: { count: number; cents: number }
  buckets: IncomeBucket[]
  byMethod: { methodName: string; currency: string; cents: number; ves: string; count: number }[]
  upcoming: { tenantId: string; tenantName: string; dueOn: string; cents: number }[]
  recent: RecentPayment[]
}

export interface RecentPayment {
  id: string
  tenantId: string
  tenantName: string
  planName: string | null
  months: number
  paidOn: string
  methodName: string
  reference: string | null
  currency: string
  receivedCents: number
  receivedAmount: string
  receiptNumber: number | null
}

/** A company's approved payments, for its page in the console (mockup web-51, frame 3). */
export interface PaymentHistory {
  totalCents: number
  count: number
  items: { id: string; paidOn: string; months: number; methodName: string; currency: string; receivedCents: number; receivedAmount: string; coversTo: string | null; receiptNumber: number | null }[]
}

const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`
const monthsBack = (day: string, months: number): string => {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 - months, 1))
  return d.toISOString().slice(0, 10)
}
const lastOfMonth = (day: string): string => addDays(monthsBack(day, -1), -1)

/** Every bucket of the period, empty ones included, oldest first. */
function bucketKeys(period: SummaryPeriod, from: string, today: string): string[] {
  if (period === 'month') {
    const end = lastOfMonth(today)
    return Array.from({ length: daysBetween(from, end) + 1 }, (_, i) => addDays(from, i))
  }
  const end = period === 'year' ? `${today.slice(0, 4)}-12-01` : firstOfMonth(today)
  const keys: string[] = []
  for (let m = firstOfMonth(from); m <= end; m = monthsBack(m, -1)) keys.push(m.slice(0, 7))
  return keys
}

/**
 * Suscripciones → Resumen (documentations/18, mockup web-51): what came in (approved payments, for
 * what really arrived, on the day they were paid; bolívares in dollars at each payment's own rate),
 * what comes in each month, what is owed, how companies pay, what falls due soon; Cobros' totals per
 * company; a company's history; and the income as a file for Excel.
 */
export class SubscriptionSummaryService {
  constructor(
    private readonly db: Database,
    private readonly subscriptions: SubscriptionService,
    private readonly today: () => string = () => caracasToday(),
  ) {}

  async summary(period: SummaryPeriod): Promise<SubscriptionSummary> {
    const today = this.today()
    const firstPaidOn = await this.firstPaidOn()
    const from = this.periodStart(period, today, firstPaidOn)
    const thisMonth = firstOfMonth(today)
    const [thisMonthCents, previousMonthCents, periodTotals, byMethod, buckets, rows, walletCents, review, upcomingPrices, recent] =
      await Promise.all([
        this.incomeBetween(thisMonth, today),
        this.incomeBetween(monthsBack(today, 1), addDays(thisMonth, -1)),
        this.periodTotals(from, today),
        this.byMethod(from, today),
        this.buckets(period, from, today),
        this.subscriptions.list(),
        this.walletTotal(),
        this.reviewTotal(),
        this.planPrices(),
        this.recent(RECENT_PAYMENTS),
      ])
    const recurringCents = await this.recurring(rows)
    const overdue = rows.filter((r) => r.state === 'grace' || r.state === 'suspended')
    const count = (states: string[]) => rows.filter((r) => states.includes(r.state)).length
    const trials = await this.activeTrials(today)
    const noPlanIds = rows.filter((r) => r.state === 'none').map((r) => r.tenantId)
    const inTrial = noPlanIds.filter((id) => trials.has(id)).length
    const horizon = addDays(today, UPCOMING_DAYS)
    const upcoming = rows
      .filter((r) => r.nextDueOn && r.state !== 'exempt' && r.state !== 'none' && r.nextDueOn >= today && r.nextDueOn <= horizon)
      .map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, dueOn: r.nextDueOn!, cents: r.owedCents > 0 ? r.owedCents : (upcomingPrices.get(r.tenantId) ?? 0) }))
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    return {
      period: { id: period, from, to: today },
      income: { thisMonthCents, previousMonthCents, ...periodTotals, firstPaidOn },
      recurringCents,
      owedCents: rows.reduce((sum, r) => sum + (r.state === 'exempt' ? 0 : r.owedCents), 0),
      overdueCents: overdue.reduce((sum, r) => sum + r.owedCents, 0),
      overdueCompanies: overdue.length,
      companies: {
        upToDate: count(['active', 'due_soon', 'in_review']),
        awaitingFirst: count(['awaiting_first_payment']),
        overdue: overdue.length,
        exempt: count(['exempt']),
        trial: inTrial,
        noPlan: noPlanIds.length - inTrial,
      },
      walletCents,
      review,
      buckets,
      byMethod,
      upcoming,
      recent,
    }
  }

  /** The approved payments of the period, as a file Excel opens (es: «;» between fields, «,» for decimals). */
  async incomeCsv(period: SummaryPeriod): Promise<string> {
    const today = this.today()
    const from = this.periodStart(period, today, await this.firstPaidOn())
    const rows = await this.db
      .select({
        paidOn: subscriptionPayments.paidOn,
        tenantName: tenants.name,
        months: subscriptionPayments.months,
        methodName: subscriptionPayments.methodName,
        reference: subscriptionPayments.reference,
        currency: subscriptionPayments.currency,
        amount: RECEIVED_VES,
        bsPerUsd: subscriptionPayments.bsPerUsd,
        cents: RECEIVED_USD,
        receiptNumber: RECEIPT_NUMBER,
      })
      .from(subscriptionPayments)
      .innerJoin(tenants, eq(tenants.id, subscriptionPayments.tenantId))
      .where(and(approved, gte(subscriptionPayments.paidOn, from), lte(subscriptionPayments.paidOn, today)))
      .orderBy(subscriptionPayments.paidOn, subscriptionPayments.submittedAt)
    const decimal = (value: string | number) => Number(value).toFixed(2).replace('.', ',')
    const header = ['Fecha del pago', 'Empresa', 'Meses', 'Método', 'Referencia', 'Moneda', 'Monto', 'Tasa (Bs/$)', 'Monto en dólares', 'Recibo']
    const lines = rows.map((r) =>
      [
        r.paidOn,
        r.tenantName,
        String(r.months),
        r.methodName,
        r.reference ?? '',
        r.currency,
        decimal(r.amount),
        r.bsPerUsd ? decimal(r.bsPerUsd) : '',
        decimal(r.cents / 100),
        r.receiptNumber ? `VTM-${String(r.receiptNumber).padStart(6, '0')}` : '',
      ]
        .map(csvCell)
        .join(';'),
    )
    return `${BOM}${[header.join(';'), ...lines].join('\r\n')}\r\n`
  }

  /** A company's approved payments, newest first, with what they paid until. */
  async history(tenantId: string): Promise<PaymentHistory> {
    const items = await this.db
      .select({
        id: subscriptionPayments.id,
        paidOn: subscriptionPayments.paidOn,
        months: subscriptionPayments.months,
        methodName: subscriptionPayments.methodName,
        currency: subscriptionPayments.currency,
        receivedCents: RECEIVED_USD,
        receivedAmount: RECEIVED_VES,
        coversTo: sql<string | null>`${subscriptionReceipts.data} -> 'period' ->> 'to'`,
        receiptNumber: subscriptionReceipts.number,
      })
      .from(subscriptionPayments)
      .leftJoin(subscriptionReceipts, eq(subscriptionReceipts.paymentId, subscriptionPayments.id))
      .where(and(approved, eq(subscriptionPayments.tenantId, tenantId)))
      .orderBy(desc(subscriptionPayments.paidOn), desc(subscriptionPayments.submittedAt))
    return { totalCents: items.reduce((sum, p) => sum + p.receivedCents, 0), count: items.length, items }
  }

  private periodStart(period: SummaryPeriod, today: string, firstPaidOn: string | null): string {
    if (period === 'month') return firstOfMonth(today)
    if (period === 'year') return `${today.slice(0, 4)}-01-01`
    if (period === '12m') return monthsBack(today, 11)
    return firstOfMonth(firstPaidOn && firstPaidOn < today ? firstPaidOn : today)
  }

  private async firstPaidOn(): Promise<string | null> {
    const [row] = await this.db.select({ day: sql<string | null>`min(${subscriptionPayments.paidOn})` }).from(subscriptionPayments).where(approved)
    return row?.day ?? null
  }

  private async incomeBetween(from: string, to: string): Promise<number> {
    const [row] = await this.db
      .select({ cents: sql<number>`coalesce(sum(${RECEIVED_USD}), 0)::int` })
      .from(subscriptionPayments)
      .where(and(approved, gte(subscriptionPayments.paidOn, from), lte(subscriptionPayments.paidOn, to)))
    return row?.cents ?? 0
  }

  private async periodTotals(from: string, to: string) {
    const [row] = await this.db
      .select({
        periodCents: sql<number>`coalesce(sum(${RECEIVED_USD}), 0)::int`,
        periodVes: sql<string>`coalesce(sum(case when ${subscriptionPayments.currency} = 'VES' then ${RECEIVED_VES} end), 0)::numeric(16,2)::text`,
        periodCount: sql<number>`count(*)::int`,
      })
      .from(subscriptionPayments)
      .where(and(approved, gte(subscriptionPayments.paidOn, from), lte(subscriptionPayments.paidOn, to)))
    return row ?? { periodCents: 0, periodVes: '0.00', periodCount: 0 }
  }

  private byMethod(from: string, to: string) {
    return this.db
      .select({
        methodName: subscriptionPayments.methodName,
        currency: subscriptionPayments.currency,
        cents: sql<number>`sum(${RECEIVED_USD})::int`,
        ves: sql<string>`coalesce(sum(case when ${subscriptionPayments.currency} = 'VES' then ${RECEIVED_VES} end), 0)::numeric(16,2)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(subscriptionPayments)
      .where(and(approved, gte(subscriptionPayments.paidOn, from), lte(subscriptionPayments.paidOn, to)))
      .groupBy(subscriptionPayments.methodName, subscriptionPayments.currency)
      .orderBy(sql`3 desc`)
  }

  private async buckets(period: SummaryPeriod, from: string, today: string): Promise<IncomeBucket[]> {
    const daily = period === 'month'
    const key = daily ? sql<string>`to_char(${subscriptionPayments.paidOn}, 'YYYY-MM-DD')` : sql<string>`to_char(${subscriptionPayments.paidOn}, 'YYYY-MM')`
    const rows = await this.db
      .select({ key, cents: sql<number>`sum(${RECEIVED_USD})::int`, count: sql<number>`count(*)::int` })
      .from(subscriptionPayments)
      .where(and(approved, gte(subscriptionPayments.paidOn, from), lte(subscriptionPayments.paidOn, today)))
      .groupBy(key)
    const found = new Map(rows.map((r) => [r.key, r]))
    return bucketKeys(period, from, today).map((k) => ({ key: k, cents: found.get(k)?.cents ?? 0, count: found.get(k)?.count ?? 0 }))
  }

  /**
   * Each paying company's month: its latest charge over its months. Only companies that already paid
   * (a billing day) and are neither exempt nor suspended count.
   */
  private async recurring(rows: SubscriptionRow[]): Promise<number> {
    const paying = new Set(rows.filter((r) => r.billingDay !== null && ['active', 'due_soon', 'in_review', 'grace'].includes(r.state)).map((r) => r.tenantId))
    if (!paying.size) return 0
    const charges = await this.db
      .selectDistinctOn([subscriptionCharges.tenantId], { tenantId: subscriptionCharges.tenantId, amountCents: subscriptionCharges.amountCents, months: subscriptionCharges.months })
      .from(subscriptionCharges)
      .orderBy(subscriptionCharges.tenantId, desc(subscriptionCharges.dueOn), desc(subscriptionCharges.createdAt))
    return charges.filter((c) => paying.has(c.tenantId)).reduce((sum, c) => sum + Math.round(c.amountCents / c.months), 0)
  }

  private async walletTotal(): Promise<number> {
    const [row] = await this.db.select({ cents: sql<number>`coalesce(sum(${walletMovements.amountCents}), 0)::int` }).from(walletMovements)
    return row?.cents ?? 0
  }

  private async reviewTotal(): Promise<{ count: number; cents: number }> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${subscriptionPayments.amountUsdCents}), 0)::int` })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.status, 'in_review'))
    return row ?? { count: 0, cents: 0 }
  }

  /** Each company's plan price, for what its next month will cost. */
  private async planPrices(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ tenantId: companySubscriptions.tenantId, priceCents: platformPlans.priceCents })
      .from(companySubscriptions)
      .innerJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
    return new Map(rows.map((r) => [r.tenantId, r.priceCents]))
  }

  private async activeTrials(today: string): Promise<Set<string>> {
    const rows = await this.db.select({ tenantId: companyTrials.tenantId }).from(companyTrials).where(gte(companyTrials.endsOn, today))
    return new Set(rows.map((r) => r.tenantId))
  }

  private recent(limit: number): Promise<RecentPayment[]> {
    return this.db
      .select({
        id: subscriptionPayments.id,
        tenantId: subscriptionPayments.tenantId,
        tenantName: tenants.name,
        planName: platformPlans.name,
        months: subscriptionPayments.months,
        paidOn: subscriptionPayments.paidOn,
        methodName: subscriptionPayments.methodName,
        reference: subscriptionPayments.reference,
        currency: subscriptionPayments.currency,
        receivedCents: RECEIVED_USD,
        receivedAmount: RECEIVED_VES,
        receiptNumber: RECEIPT_NUMBER,
      })
      .from(subscriptionPayments)
      .innerJoin(tenants, eq(tenants.id, subscriptionPayments.tenantId))
      .leftJoin(companySubscriptions, eq(companySubscriptions.tenantId, subscriptionPayments.tenantId))
      .leftJoin(platformPlans, eq(platformPlans.id, companySubscriptions.planId))
      .where(approved)
      .orderBy(desc(subscriptionPayments.paidOn), desc(subscriptionPayments.submittedAt))
      .limit(limit)
  }
}

/** One field of the file: quoted when it must be, and never read by Excel as a formula (OWASP CSV injection). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

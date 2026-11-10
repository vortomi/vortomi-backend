import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { tenants } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { PaymentCurrency } from '../payment-methods/payment-method-types.ts'
import type { OrderService, OrderView } from './order-service.ts'
import { expectedAmount } from './payment-proof.ts'

/** The day to close ("2026-11-10"); today on the company's clock when left out. */
export const dailyCloseQuery = z.object({ date: z.iso.date().optional() })

/** One sold order of the day, with what should have arrived and what the person wrote down. */
export interface CloseOrder {
  id: string
  code: string
  customerName: string
  paymentMethod: OrderView['paymentMethod']
  currency: PaymentCurrency
  totalCents: number
  expectedAmount: string | null
  receivedAmount: string | null
  paymentReference: string | null
  confirmedAt: Date | null
  confirmedBy: string | null
}

/** The day's orders paid with one payment method (or without one), added up. */
export interface CloseGroup {
  paymentMethod: OrderView['paymentMethod']
  currency: PaymentCurrency
  count: number
  totalCents: number
  /** What should have arrived, of the orders where it can be known. */
  expectedAmount: string
  /** What the team wrote down as arrived. */
  receivedAmount: string
  /** Orders whose arrived amount nobody wrote down. */
  withoutReceived: number
}

export interface DailyClose {
  date: string
  timezone: string
  count: number
  totalCents: number
  byMethod: CloseGroup[]
  orders: CloseOrder[]
}

const toCents = (amount: string) => Math.round(Number(amount) * 100)
const fromCents = (cents: number) => (cents / 100).toFixed(2)

/**
 * The day's close: the orders confirmed that day (still sold: a cancelled one drops out), by payment
 * method and currency. Each person closes the orders of the conversations they see; admins, all.
 */
export class DailyCloseService {
  constructor(private readonly orders: OrderService) {}

  async close(scope: MemberScope, date?: string): Promise<DailyClose> {
    const [company] = await scope.tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, scope.tenantId))
    const timezone = company!.timezone
    const day = date ?? new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
    const sold = await this.orders.list(scope, { soldOn: { date: day, timezone } })
    const orders = sold
      .map((o): CloseOrder => {
        const currency = o.paymentMethod?.currency ?? 'USD'
        return {
          id: o.id,
          code: o.code,
          customerName: o.customerName,
          paymentMethod: o.paymentMethod,
          currency,
          totalCents: o.subtotalCents + (o.deliveryCents ?? 0),
          expectedAmount: expectedAmount(o, currency),
          receivedAmount: o.receivedAmount,
          paymentReference: o.paymentReference,
          confirmedAt: o.confirmedAt,
          confirmedBy: o.confirmedBy,
        }
      })
      .sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0))
    return { date: day, timezone, count: orders.length, totalCents: orders.reduce((sum, o) => sum + o.totalCents, 0), byMethod: groupByMethod(orders), orders }
  }
}

function groupByMethod(orders: CloseOrder[]): CloseGroup[] {
  const groups = new Map<string, { group: Omit<CloseGroup, 'expectedAmount' | 'receivedAmount'>; expected: number; received: number }>()
  for (const o of orders) {
    const key = o.paymentMethod?.id ?? 'none'
    const entry = groups.get(key) ?? { group: { paymentMethod: o.paymentMethod, currency: o.currency, count: 0, totalCents: 0, withoutReceived: 0 }, expected: 0, received: 0 }
    entry.group.count++
    entry.group.totalCents += o.totalCents
    if (o.expectedAmount) entry.expected += toCents(o.expectedAmount)
    if (o.receivedAmount) entry.received += toCents(o.receivedAmount)
    else entry.group.withoutReceived++
    groups.set(key, entry)
  }
  return [...groups.values()]
    .map(({ group, expected, received }) => ({ ...group, expectedAmount: fromCents(expected), receivedAmount: fromCents(received) }))
    .sort((a, b) => b.totalCents - a.totalCents)
}

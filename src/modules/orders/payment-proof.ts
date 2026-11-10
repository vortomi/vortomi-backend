import { and, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { OrderStatus } from '../../db/schema/enums.ts'
import { orders, paymentMethods } from '../../db/schema/index.ts'
import type { PaymentCurrency } from '../payment-methods/payment-method-types.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'

/** Statuses in which an order counts as sold: its payment was checked by a person. */
export const SOLD: readonly OrderStatus[] = ['confirmed', 'done']

/** The payment method asks for a reference and the order has none yet. */
export class PaymentReferenceRequiredError extends Error {
  constructor() {
    super('This payment method needs the payment reference before the order is confirmed')
    this.name = 'PaymentReferenceRequiredError'
  }
}

/** Another sold order of the same payment method was already paid with that reference. */
export class PaymentReferenceUsedError extends Error {
  constructor() {
    super('That payment reference already paid another order')
    this.name = 'PaymentReferenceUsedError'
  }
}

/** "000 123 456" -> "000123456": as the bank prints it, without spaces, in capitals. */
export const normalizeReference = (text: string) => text.replace(/\s+/g, '').toUpperCase()

/** At least 4 characters (some banks only print the last ones); letters for Zelle, Binance... */
const REFERENCE = /^[A-Z0-9-]{4,40}$/

/** What whoever checks the payment writes down. Empty clears a value. */
export const paymentCheckInput = z.object({
  reference: z
    .string()
    .max(60)
    .transform(normalizeReference)
    .refine((r) => r === '' || REFERENCE.test(r), 'At least 4 letters or digits'),
  // "1234.56" in the payment method's currency.
  receivedAmount: z
    .string()
    .trim()
    .regex(/^(\d{1,12}(\.\d{1,2})?)?$/)
    .refine((v) => v === '' || Number(v) > 0, 'More than zero'),
})
export type PaymentCheck = z.infer<typeof paymentCheckInput>

/** The fields of an order its payment proof is checked on. */
export interface ProofOrder {
  id: string
  paymentMethodId: string | null
  paymentReference: string | null
}

/** Codes of the other orders (in these statuses) of the same payment method with the same reference. */
export async function ordersWithReference(scope: TenantScope, order: ProofOrder, statuses: readonly OrderStatus[]): Promise<string[]> {
  if (!order.paymentMethodId || !order.paymentReference) return []
  const rows = await scope.tx
    .select({ code: orders.code })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, scope.tenantId),
        eq(orders.paymentMethodId, order.paymentMethodId),
        eq(orders.paymentReference, order.paymentReference),
        ne(orders.id, order.id),
        inArray(orders.status, [...statuses]),
      ),
    )
  return rows.map((r) => r.code)
}

/**
 * What an order needs before it counts as sold: the reference when its payment method asks for one,
 * and a reference no other sold order of that method used. The database enforces the second too
 * (orders_paid_reference_key); checking first gives a clear answer.
 */
export async function checkPaymentProof(scope: TenantScope, order: ProofOrder): Promise<void> {
  if (!order.paymentMethodId) return
  const [method] = await scope.tx
    .select({ referenceRule: paymentMethods.referenceRule })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, scope.tenantId), eq(paymentMethods.id, order.paymentMethodId)))
  if (method?.referenceRule === 'required' && !order.paymentReference) throw new PaymentReferenceRequiredError()
  if ((await ordersWithReference(scope, order, SOLD)).length) throw new PaymentReferenceUsedError()
}

/** The amounts an order is priced with. */
export interface PricedOrder {
  subtotalCents: number
  deliveryCents: number | null
  bsPerUsd: string | null
}

/**
 * What should arrive, in the payment method's currency ("8880.00"): dollars as priced, bolívares at
 * the rate the order was priced with. Null when it cannot be known: delivery still to be priced, no
 * rate for bolívares, or euros (Vortomi keeps no euro rate).
 */
export function expectedAmount(order: PricedOrder, currency: PaymentCurrency): string | null {
  if (order.deliveryCents === null) return null
  const cents = order.subtotalCents + order.deliveryCents
  if (currency === 'USD') return (cents / 100).toFixed(2)
  if (currency === 'VES' && order.bsPerUsd) return (Math.round(cents * Number(order.bsPerUsd)) / 100).toFixed(2)
  return null
}

/** Below this share of the expected amount, a difference is rounding of the rate, not a short payment. */
const SHORT_TOLERANCE = 0.005

/** How much is missing ("40.00") when what arrived is clearly less than expected; null otherwise. */
export function shortBy(expected: string | null, received: string | null): string | null {
  if (expected === null || received === null) return null
  const missing = Number(expected) - Number(received)
  return missing > Number(expected) * SHORT_TOLERANCE ? missing.toFixed(2) : null
}

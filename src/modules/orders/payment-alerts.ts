import { and, eq, inArray, ne } from 'drizzle-orm'
import { mediaFiles, orderReceipts, orders } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import { type ProofOrder, ordersWithReference, shortBy } from './payment-proof.ts'

/**
 * What does not add up in an order's payment, for whoever checks it. Only from what is stored in
 * the company: nothing is read from the receipt and nobody outside is asked.
 */
export interface PaymentAlerts {
  /** Other orders (not cancelled) of the same payment method with the same reference. */
  referenceUsedIn: string[]
  /** Other orders (not cancelled) that got the very same receipt file. */
  receiptUsedIn: string[]
  /** How much is missing, in the payment method's currency, when less arrived than the order costs. */
  shortBy: string | null
}

const NOT_CANCELLED = ['awaiting_payment', 'payment_review', 'confirmed', 'done'] as const

export async function paymentAlerts(scope: TenantScope, order: ProofOrder, amounts: { expected: string | null; received: string | null }): Promise<PaymentAlerts> {
  const [referenceUsedIn, receiptUsedIn] = await Promise.all([ordersWithReference(scope, order, NOT_CANCELLED), ordersWithSameReceipt(scope, order.id)])
  return { referenceUsedIn, receiptUsedIn, shortBy: shortBy(amounts.expected, amounts.received) }
}

/** Codes of the other orders with a receipt identical (same fingerprint) to one of this order. */
async function ordersWithSameReceipt(scope: TenantScope, orderId: string): Promise<string[]> {
  const own = scope.tx
    .select({ sha256: mediaFiles.sha256 })
    .from(orderReceipts)
    .innerJoin(mediaFiles, and(eq(mediaFiles.tenantId, orderReceipts.tenantId), eq(mediaFiles.id, orderReceipts.mediaId)))
    .where(and(eq(orderReceipts.tenantId, scope.tenantId), eq(orderReceipts.orderId, orderId)))
  const rows = await scope.tx
    .selectDistinct({ code: orders.code })
    .from(orderReceipts)
    .innerJoin(mediaFiles, and(eq(mediaFiles.tenantId, orderReceipts.tenantId), eq(mediaFiles.id, orderReceipts.mediaId)))
    .innerJoin(orders, and(eq(orders.tenantId, orderReceipts.tenantId), eq(orders.id, orderReceipts.orderId)))
    .where(
      and(
        eq(orderReceipts.tenantId, scope.tenantId),
        ne(orderReceipts.orderId, orderId),
        inArray(orders.status, [...NOT_CANCELLED]),
        inArray(mediaFiles.sha256, own),
      ),
    )
  return rows.map((r) => r.code)
}

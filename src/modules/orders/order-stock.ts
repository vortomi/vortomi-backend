import { and, eq, inArray, sql } from 'drizzle-orm'
import { orderLines, productVariants, products, stockMovements } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

/** A product the inventory did not have enough of when its order was sold. */
export interface StockShortfall {
  name: string
  missing: number
}

/** The order whose stock moves. */
export interface StockOrder {
  id: string
  code: string
}

// Lines priced from Vortomi's inventory point to a variant; those of a company's own system
// (La Campiña) carry that system's ids, which are never variants: their stock is not ours.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const round2 = (n: number) => Math.round(n * 100) / 100

/** What the order's movements add up to, per variant: negative while its sale is in the stock. */
async function netByVariant(scope: MemberScope, orderId: string): Promise<Map<string, number>> {
  const rows = await scope.tx
    .select({ variantId: stockMovements.variantId, net: sql<string>`sum(${stockMovements.quantity})` })
    .from(stockMovements)
    .where(and(eq(stockMovements.tenantId, scope.tenantId), eq(stockMovements.orderId, orderId)))
    .groupBy(stockMovements.variantId)
  return new Map(rows.map((r) => [r.variantId, round2(Number(r.net))]))
}

/**
 * Takes an order's products out of the inventory when it is sold, once: an order whose sale is
 * already in the stock is left alone. Products counted by units only; what the inventory does not
 * have is not taken (the stock never goes below what is set aside) and comes back as a shortfall,
 * so the person is told to check the inventory. The order is confirmed anyway: the money arrived.
 */
export async function takeStock(scope: MemberScope, order: StockOrder): Promise<StockShortfall[]> {
  const net = await netByVariant(scope, order.id)
  if ([...net.values()].some((n) => n < 0)) return []
  const lines = (
    await scope.tx
      .select({ ref: orderLines.productRef, name: orderLines.name, quantity: orderLines.quantity })
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scope.tenantId), eq(orderLines.orderId, order.id)))
      .orderBy(orderLines.position)
  ).filter((line) => UUID.test(line.ref))
  if (!lines.length) return []

  // Locked until the transaction ends: two orders sold at once cannot both take the last unit.
  const variants = await scope.tx
    .select({ id: productVariants.id, onHand: productVariants.onHand, reserved: productVariants.reserved })
    .from(productVariants)
    .innerJoin(products, and(eq(products.tenantId, productVariants.tenantId), eq(products.id, productVariants.productId)))
    .where(and(eq(productVariants.tenantId, scope.tenantId), inArray(productVariants.id, lines.map((l) => l.ref)), eq(products.stockMode, 'units')))
    .for('update', { of: productVariants })
  const free = new Map(variants.map((v) => [v.id, Math.max(0, round2(v.onHand - v.reserved))]))

  const shortfalls: StockShortfall[] = []
  const moves: (typeof stockMovements.$inferInsert)[] = []
  for (const line of lines) {
    const available = free.get(line.ref)
    if (available === undefined) continue
    const taken = Math.min(line.quantity, available)
    free.set(line.ref, round2(available - taken))
    if (taken > 0) moves.push({ tenantId: scope.tenantId, variantId: line.ref, kind: 'sale', quantity: -taken, reason: `Pedido ${order.code}`, userId: scope.member.userId, orderId: order.id })
    if (taken < line.quantity) shortfalls.push({ name: line.name, missing: round2(line.quantity - taken) })
  }
  if (moves.length) await scope.tx.insert(stockMovements).values(moves)
  return shortfalls
}

/** Puts back what an order took when it stops counting as sold (cancelled or reopened). */
export async function giveBackStock(scope: MemberScope, order: StockOrder): Promise<void> {
  const moves = [...(await netByVariant(scope, order.id)).entries()]
    .filter(([, net]) => net < 0)
    .map(([variantId, net]) => ({
      tenantId: scope.tenantId,
      variantId,
      kind: 'return' as const,
      quantity: -net,
      reason: `Pedido ${order.code} anulado`,
      userId: scope.member.userId,
      orderId: order.id,
    }))
  if (moves.length) await scope.tx.insert(stockMovements).values(moves)
}

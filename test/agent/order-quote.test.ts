// Quantities of an order: pieces count whole, what is sold by the kilo (or metre, litre, hour)
// takes up to 2 decimals within the product's minimum and steps, and each line costs its
// quantity times the unit price rounded to the cent, so the total always adds up.
import { describe, expect, it } from 'vitest'
import type { AgentCatalog, CatalogItem } from '../../src/modules/agent/agent-catalog.ts'
import { UNIT_RULE } from '../../src/modules/inventory/sale-quantity.ts'
import { type OrderRequest, lineCents, orderRequest, quoteOrder } from '../../src/modules/orders/order-quote.ts'

const ITEMS: CatalogItem[] = [
  { ref: 'v1', name: 'Queso blanco', unitPriceCents: 999, available: true, rule: { saleUnit: 'kg', minQuantity: 0.1, quantityStep: 0.05 } },
  { ref: 'v2', name: 'Refresco', unitPriceCents: 150, available: true, rule: UNIT_RULE },
]
const catalog: AgentCatalog = {
  bsPerUsd: '100.00',
  forPrompt: () => Promise.resolve({ products: [] }),
  search: () => Promise.resolve({ products: [] }),
  resolve: (name) => Promise.resolve(ITEMS.find((i) => i.name === name) ?? null),
}
const terms = { delivery: { configured: true, enabled: false, mode: 'flat' as const, flatPriceCents: 0, charge: 'per_order' as const, zones: [] }, paymentMethods: [] }
const order = (items: OrderRequest['items']): OrderRequest => ({ customerName: 'Ana', items, fulfillment: 'pickup' })

describe('quantities with decimals', () => {
  it('150 g of cheese and two sodas: each line rounded to the cent, the total is their sum', async () => {
    const quote = await quoteOrder(order([{ product: 'Queso blanco', quantity: 0.15 }, { product: 'Refresco', quantity: 2 }]), catalog, terms)
    expect(quote.lines.map((l) => [l.quantity, l.saleUnit, lineCents(l)])).toEqual([
      [0.15, 'kg', 150],
      [2, 'unit', 300],
    ])
    expect(quote.subtotalCents).toBe(450)
  })

  it('no fractions of pieces, nothing under the minimum or off the steps, never 3 decimals', async () => {
    await expect(quoteOrder(order([{ product: 'Refresco', quantity: 1.5 }]), catalog, terms)).rejects.toThrow('whole units')
    await expect(quoteOrder(order([{ product: 'Queso blanco', quantity: 0.05 }]), catalog, terms)).rejects.toThrow('at least 0.1')
    await expect(quoteOrder(order([{ product: 'Queso blanco', quantity: 0.12 }]), catalog, terms)).rejects.toThrow('steps of 0.05')
    expect(orderRequest.safeParse(order([{ product: 'Queso blanco', quantity: 0.125 }])).success).toBe(false)
  })

  it('a line costs quantity × unit price, rounded once (no float drift)', () => {
    expect(lineCents({ quantity: 1.25, unitPriceCents: 340 })).toBe(425)
    expect(lineCents({ quantity: 0.1, unitPriceCents: 333 })).toBe(33)
    expect(lineCents({ quantity: 3, unitPriceCents: 90 })).toBe(270)
  })
})

describe('delivery charged per piece', () => {
  const zones = { configured: true, enabled: true, mode: 'zones' as const, flatPriceCents: 0, zones: [{ name: 'La Campiña', priceCents: 60 }] }
  const jug: CatalogItem = { ref: 'j1', name: 'Recarga 19L', unitPriceCents: 90, available: true, rule: UNIT_RULE }
  const withJug: AgentCatalog = { ...catalog, resolve: (name) => Promise.resolve([...ITEMS, jug].find((i) => i.name === name) ?? null) }
  const delivered = (items: OrderRequest['items']): OrderRequest => ({ ...order(items), fulfillment: 'delivery', zone: 'la campina', address: 'Calle 3, frente a la plaza' })

  it('3 jugs at $0.90 with $0.60 per piece: $1.80 of delivery, $4.50 in all', async () => {
    const quote = await quoteOrder(delivered([{ product: 'Recarga 19L', quantity: 3 }]), withJug, { delivery: { ...zones, charge: 'per_piece' }, paymentMethods: [] })
    expect([quote.subtotalCents, quote.deliveryCents, quote.deliveryPieces]).toEqual([270, 180, 3])
    expect(quote.subtotalCents + quote.deliveryCents!).toBe(450)
  })

  it('per order the same jugs pay one trip; weighed products count once; pickup pays nothing', async () => {
    const perOrder = await quoteOrder(delivered([{ product: 'Recarga 19L', quantity: 3 }]), withJug, { delivery: { ...zones, charge: 'per_order' }, paymentMethods: [] })
    expect([perOrder.deliveryCents, perOrder.deliveryPieces]).toEqual([60, null])
    const mixed = await quoteOrder(delivered([{ product: 'Recarga 19L', quantity: 2 }, { product: 'Queso blanco', quantity: 0.5 }]), withJug, { delivery: { ...zones, charge: 'per_piece' }, paymentMethods: [] })
    expect([mixed.deliveryCents, mixed.deliveryPieces]).toEqual([180, 3])
    const pickup = await quoteOrder(order([{ product: 'Recarga 19L', quantity: 3 }]), withJug, { delivery: { ...zones, charge: 'per_piece' }, paymentMethods: [] })
    expect([pickup.deliveryCents, pickup.deliveryPieces]).toEqual([0, null])
  })
})

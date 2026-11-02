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
const terms = { delivery: { configured: true, enabled: false, mode: 'flat' as const, flatPriceCents: 0, zones: [] }, paymentMethods: [] }
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

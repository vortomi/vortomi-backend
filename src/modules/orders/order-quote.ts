import { z } from 'zod'
import { FULFILLMENTS, type SaleUnit } from '../../db/schema/enums.ts'
import type { AgentCatalog } from '../agent/agent-catalog.ts'
import { type SaleRule, canSell, hasAtMostTwoDecimals, takesDecimals } from '../inventory/sale-quantity.ts'
import type { DeliveryView } from '../delivery/delivery-service.ts'
import type { PaymentMethodView } from '../payment-methods/payment-method-service.ts'

/** What the agent collected from the customer. Prices are never part of it: the server sets them. */
export const orderRequest = z.object({
  customerName: z.string().trim().min(1).max(80),
  // In each product's sale unit: 2 (pieces) or 0.75 (kilos); the catalog says which fits.
  items: z.array(z.object({ product: z.string().trim().min(1).max(120), quantity: z.number().positive().max(1000).refine(hasAtMostTwoDecimals) })).min(1).max(20),
  fulfillment: z.enum(FULFILLMENTS),
  zone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  /** The name of one of the company's visible payment methods. */
  paymentMethod: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
})
export type OrderRequest = z.infer<typeof orderRequest>

export interface PricedLine {
  productRef: string
  name: string
  quantity: number
  saleUnit: SaleUnit
  unitPriceCents: number
}

/** What a line costs: quantity × price of one unit, rounded to the cent (0,15 kg × $9,99 = $1,50). */
export const lineCents = (line: Pick<PricedLine, 'quantity' | 'unitPriceCents'>) => Math.round((Math.round(line.quantity * 100) * line.unitPriceCents) / 100)

/** An order priced from the catalog and the settings of right now, not saved yet. */
export interface OrderQuote {
  request: OrderRequest
  lines: PricedLine[]
  subtotalCents: number
  /** Null: delivery whose cost a person confirms. */
  deliveryCents: number | null
  bsPerUsd: string | null
  /** Null when the company has no payment methods yet (a person tells the customer how to pay). */
  paymentMethod: PaymentMethodView | null
}

/** Everything of the company an order is priced against. */
export interface OrderTerms {
  delivery: DeliveryView
  /** Visible methods only. */
  paymentMethods: PaymentMethodView[]
}

/** What the agent must fix before an order can be priced: said to the model, in plain words. */
export class OrderProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderProblem'
  }
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

/** Prices an order: every product must be in the catalog and available; delivery and payment from the settings. */
export async function quoteOrder(request: OrderRequest, catalog: AgentCatalog, terms: OrderTerms): Promise<OrderQuote> {
  const lines: PricedLine[] = []
  for (const item of request.items) {
    const found = await catalog.resolve(item.product)
    if (!found) throw new OrderProblem(`"${item.product}" is not in the catalog. Use the exact product names of the catalog, or ask the customer.`)
    if (!found.available) throw new OrderProblem(`"${found.name}" is not available right now. Tell the customer and offer something else.`)
    if (!canSell(item.quantity, found.rule)) throw new OrderProblem(quantityProblem(found.name, found.rule))
    lines.push({ productRef: found.ref, name: found.name, quantity: item.quantity, saleUnit: found.rule.saleUnit, unitPriceCents: found.unitPriceCents })
  }
  return {
    request,
    lines,
    subtotalCents: lines.reduce((sum, l) => sum + lineCents(l), 0),
    deliveryCents: deliveryCost(request, terms.delivery),
    bsPerUsd: catalog.bsPerUsd,
    paymentMethod: chosenMethod(request, terms.paymentMethods),
  }
}

/** How much of a product can be ordered, said to the model so it can ask the customer again. */
function quantityProblem(name: string, rule: SaleRule): string {
  if (!takesDecimals(rule.saleUnit)) return `"${name}" is sold in whole units (${rule.saleUnit}), at least ${rule.minQuantity}. Ask the customer for a whole quantity.`
  return `"${name}" is sold by ${rule.saleUnit}: at least ${rule.minQuantity}, in steps of ${rule.quantityStep}. Ask the customer for a quantity that fits.`
}

function deliveryCost(request: OrderRequest, delivery: DeliveryView): number | null {
  if (request.fulfillment === 'pickup') return 0
  if (!request.address) throw new OrderProblem('Delivery needs the exact address with a reference point: ask the customer.')
  if (!delivery.configured) return null
  if (!delivery.enabled) throw new OrderProblem('The business does not deliver: the customer picks up the order.')
  if (delivery.mode === 'flat') return delivery.flatPriceCents
  const zone = request.zone ? delivery.zones.find((z) => fold(z.name) === fold(request.zone!)) : undefined
  return zone ? zone.priceCents : null
}

function chosenMethod(request: OrderRequest, methods: PaymentMethodView[]): PaymentMethodView | null {
  if (!methods.length) return null
  const names = methods.map((m) => `"${m.name}"`).join(', ')
  if (!request.paymentMethod) throw new OrderProblem(`Ask the customer how they will pay. The business accepts: ${names}.`)
  const method = methods.find((m) => fold(m.name) === fold(request.paymentMethod!))
  if (!method) throw new OrderProblem(`"${request.paymentMethod}" is not a payment method of the business. It accepts: ${names}.`)
  return method
}

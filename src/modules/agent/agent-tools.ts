import type { HandoffReason } from '../../db/schema/enums.ts'
import { type OrderQuote, type OrderRequest, type OrderTerms, lineCents, orderRequest, quoteOrder } from '../orders/order-quote.ts'
import { amountText } from '../payment-methods/payment-message.ts'
import type { AgentCatalog } from './agent-catalog.ts'
import type { AgentTool } from './chat-model.ts'

/** What the agent asked for while answering, applied once its answer is stored. */
export interface AgentIntent {
  handoff: HandoffReason | null
  /** The order saved in this answer: its payment data goes to the customer right after it. */
  placed: { code: string; quote: OrderQuote } | null
}

/** Where the agent's orders go: the company's delivery and payment settings, and saving a confirmed order. */
export interface OrderDesk {
  terms: OrderTerms
  place(quote: OrderQuote): Promise<{ code: string }>
}

/** Only the reasons the model may give; the rest are the system's own (orders, errors, limits). */
const MODEL_REASONS = ['customer_asked', 'purchase', 'agent_unsure'] as const satisfies readonly HandoffReason[]

/** The order as the model describes it; prices are never part of it. */
const orderProperties = (terms: OrderTerms) => ({
  customerName: { type: 'string', description: 'Name the order goes under.' },
  items: {
    type: 'array',
    description: 'Products with the exact catalog name, and how many.',
    items: {
      type: 'object',
      properties: { product: { type: 'string' }, quantity: { type: 'number', description: 'In the product sale unit, up to 2 decimals: 2 pieces, or 0.15 for 150 g of something sold by the kilo.' } },
      required: ['product', 'quantity'],
    },
  },
  fulfillment: { type: 'string', enum: ['pickup', 'delivery'] },
  zone: { type: 'string', description: 'Delivery zone, as the business names it.' },
  address: { type: 'string', description: 'Exact delivery address with a reference point.' },
  paymentMethod: terms.paymentMethods.length
    ? { type: 'string', enum: terms.paymentMethods.map((m) => m.name), description: 'The payment method the customer chose.' }
    : { type: 'string', description: 'How the customer says they will pay (the business has not listed its methods).' },
  notes: { type: 'string' },
})

const usd = (cents: number) => (cents / 100).toFixed(2)
const bs = (cents: number, rate: string | null) => (rate ? ((cents / 100) * Number(rate)).toFixed(2) : undefined)

/** The summary the model shows the customer: every line, delivery and total, in $ and Bs. */
function summary(quote: OrderQuote) {
  const rate = quote.bsPerUsd
  const known = quote.deliveryCents ?? 0
  return {
    lines: quote.lines.map((l) => ({ product: l.name, quantity: l.quantity, unit: l.saleUnit, unitUsd: usd(l.unitPriceCents), unitBs: bs(l.unitPriceCents, rate), lineUsd: usd(lineCents(l)), lineBs: bs(lineCents(l), rate) })),
    delivery:
      quote.request.fulfillment === 'pickup'
        ? 'pickup at the store'
        : quote.deliveryCents === null
          ? 'delivery cost to be confirmed by a person'
          : { usd: usd(quote.deliveryCents), bs: bs(quote.deliveryCents, rate) },
    totalUsd: usd(quote.subtotalCents + known),
    totalBs: bs(quote.subtotalCents + known, rate),
    ...(quote.paymentMethod
      ? { paymentMethod: quote.paymentMethod.name, amountToPay: amountText(quote.subtotalCents + known, quote.paymentMethod.currency, rate, quote.paymentMethod.type === 'binance') }
      : {}),
    ...(quote.deliveryCents === null && quote.request.fulfillment === 'delivery' ? { note: 'The total does not include delivery yet.' } : {}),
  }
}

/** The model's arguments as an order request, or what is wrong with them. */
function readOrder(args: Record<string, unknown>): OrderRequest {
  const parsed = orderRequest.safeParse(args)
  if (!parsed.success) throw new Error(`Incomplete order: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}. Ask the customer for what is missing.`)
  return parsed.data
}

/** Passing the chat to a person: the agent's only tool while an order of the customer is in progress. */
export function handOffTool(intent: AgentIntent): AgentTool {
  return {
    name: 'hand_off_to_person',
    description:
      'Passes the conversation to a person of the team, who continues it. Use it when the customer asks for a person ' +
      '("customer_asked"), wants something you cannot do ("purchase"), or you cannot answer ("agent_unsure").',
    parameters: { type: 'object', properties: { reason: { type: 'string', enum: [...MODEL_REASONS] } }, required: ['reason'] },
    run: (args) => {
      const reason = args['reason']
      intent.handoff = MODEL_REASONS.find((r) => r === reason) ?? 'agent_unsure'
      return Promise.resolve({ done: true, tellTheCustomer: 'In first person, say you will check it and get back to them shortly. Do not mention anyone else.' })
    },
  }
}

/**
 * The agent's tools for one company. They read only that company's catalog (its inventory or its
 * own system); the only things they write are a confirmed order and the intent to pass the chat
 * to a person. Prices always come from the catalog, never from the model.
 */
export function agentTools(catalog: AgentCatalog, intent: AgentIntent, desk: OrderDesk | null = null): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'search_products',
      description:
        'Searches the business catalog by words (product name, brand, model, size, use) and returns matching products ' +
        'with their price in dollars and bolívares and their availability. Use it before giving any price or stock.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Words to look for, e.g. "pastillas freno corolla" or "recarga 19".' } },
        required: ['query'],
      },
      run: (args) => catalog.search(typeof args['query'] === 'string' ? args['query'] : ''),
    },
    handOffTool(intent),
  ]
  if (!desk) return tools

  tools.push(
    {
      name: 'quote_order',
      description:
        'Prices an order with the catalog and the delivery settings, without saving it. Call it once you have the products, ' +
        'quantities, pickup or delivery (zone and exact address), name and payment method; show the customer the summary it ' +
        'returns and ask them to confirm.',
      parameters: { type: 'object', properties: orderProperties(desk.terms), required: ['customerName', 'items', 'fulfillment'] },
      run: async (args) => summary(await quoteOrder(readOrder(args), catalog, desk.terms)),
    },
    {
      name: 'place_order',
      description:
        'Saves the order and passes it to a person of the team, who confirms payment and delivery. Only after the customer ' +
        'clearly confirmed the summary of quote_order, with exactly the same data.',
      parameters: {
        type: 'object',
        properties: { ...orderProperties(desk.terms), customerConfirmed: { type: 'boolean', description: 'True only if the customer confirmed the summary.' } },
        required: ['customerName', 'items', 'fulfillment', 'customerConfirmed'],
      },
      run: async (args) => {
        if (args['customerConfirmed'] !== true) throw new Error('The customer has not confirmed the summary yet: show it and ask them to confirm first.')
        const quote = await quoteOrder(readOrder(args), catalog, desk.terms)
        const { code } = await desk.place(quote)
        intent.handoff = 'order_placed'
        intent.placed = { code, quote }
        // The code stays internal: customers are never given it.
        return {
          saved: true,
          ...summary(quote),
          tellTheCustomer: quote.paymentMethod
            ? 'The business answers the customer itself with the payment details: your reply is not sent this time.'
            : 'Thank the customer and tell them, in first person, that you will send them how to pay and confirm the delivery shortly.',
        }
      },
    },
  )
  return tools
}

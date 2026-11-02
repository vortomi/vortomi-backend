// Orders taken by the sales agent: priced by the server from the catalog, the delivery settings and
// the payment methods (never by the model), saved only after the customer confirms, once per
// customer message; then the server sends the payment data, the customer's receipt is kept with the
// order, and whoever sees the conversation confirms it (the customer is told).
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { agentSettings, conversations, deliverySettings, orderLines, orderReceipts, orders, paymentMethods } from '../../src/db/schema/index.ts'
import type { ChatModel, ChatReply, ChatRequest } from '../../src/modules/agent/chat-model.ts'
import { SalesAgent } from '../../src/modules/agent/sales-agent.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { BotDelivery } from '../../src/modules/messaging/bot-delivery.ts'
import { ReceiptCollector } from '../../src/modules/orders/receipt-collector.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import type { MediaDownloader } from '../../src/modules/whatsapp/cloud-api.client.ts'
import { FakeSender, buildTestApp, silentLog, testCredentials } from '../helpers/app.ts'
import { bearer, seedAssignees, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

class FakeModel implements ChatModel {
  calls: { name: string; args: Record<string, unknown> }[] = []
  results: unknown[] = []
  requests: ChatRequest[] = []
  async reply(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request)
    for (const call of this.calls) {
      try {
        this.results.push(await request.tools.find((t) => t.name === call.name)!.run(call.args))
      } catch (error) {
        this.results.push({ error: (error as Error).message })
      }
    }
    return { text: 'Listo', usage: { inputTokens: 1, outputTokens: 1 } }
  }
}

class FakeDownloader implements MediaDownloader {
  readonly asked: string[] = []
  downloadMedia(mediaId: string) {
    this.asked.push(mediaId)
    return Promise.resolve({ bytes: Buffer.from('fake-jpeg-bytes'), mimeType: 'image/jpeg' })
  }
}

const NOW = new Date('2026-10-29T15:00:00Z')
const CATALOG = {
  bsPerUsd: 888.1183,
  rateDate: '2026-10-28',
  fetchedAt: NOW,
  stale: false,
  products: [
    { id: 'p1', name: 'Recarga 19L', kind: 'refill' as const, priceUsd: 0.9, priceVes: 799.31, available: true, stock: null },
    { id: 'p6', name: 'Bolsa de Hielo', kind: 'unit' as const, priceUsd: 2, priceVes: 1776.24, available: false, stock: 0 },
  ],
}
const ORDER = { customerName: 'María Pérez', items: [{ product: 'recarga 19l', quantity: 2 }], fulfillment: 'delivery', zone: 'centro', address: 'Calle 5, casa 12, frente a la plaza', paymentMethod: 'pago movil' }

let t: TestDatabase
let a: SeededTenant
let app: FastifyInstance
let model: FakeModel
// One sender for the agent and the panel: its fake WhatsApp ids never repeat.
const sender = new FakeSender()
let sentBefore = 0
let credentials: ChannelCredentials
let counter = 0
const who = { laura: '', carlos: '' }
const placed = { conversationId: '', cashConversationId: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await t.db.insert(agentSettings).values({ tenantId: a.tenantId, enabled: true })
  await t.db.insert(deliverySettings).values({ tenantId: a.tenantId, enabled: true, mode: 'zones', zones: [{ name: 'Centro', priceCents: 100 }] })
  await t.db.insert(paymentMethods).values([
    {
      tenantId: a.tenantId,
      type: 'pago_movil',
      name: 'Pago móvil',
      fields: [
        { kind: 'bank', label: 'Banco', value: '0134 · Banesco', copyable: true },
        { kind: 'phone', label: 'Teléfono', value: '0414-1234567', copyable: true },
        { kind: 'document', label: 'RIF', value: 'J-50472711-3', copyable: true },
      ],
      sortOrder: 0,
    },
    { tenantId: a.tenantId, type: 'cash_usd', name: 'Efectivo en dólares', referenceRule: 'none', receiptRule: 'none', sortOrder: 1 },
    { tenantId: a.tenantId, type: 'zelle', name: 'Zelle', isActive: false, sortOrder: 2 },
  ])
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAG-token-a')
  app = await buildTestApp(t.db, { sender, credentials })
})
afterAll(async () => {
  await app.close()
  await t.close()
})
beforeEach(() => {
  model = new FakeModel()
  sentBefore = sender.sent.length
})

const agent = () =>
  new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), model, {
    monthlyCap: 1000,
    debounceMs: 60_000,
    log: silentLog,
    now: () => NOW,
    catalogs: { lookup: () => Promise.resolve({ source: 'external' as const, catalog: CATALOG }) },
  })

async function customerWrites(from: string, body: string) {
  const event = { kind: 'inbound_message' as const, phoneNumberId: a.phoneNumberId, waMessageId: `wamid.order.${++counter}`, timestamp: NOW, from, profileName: 'Cliente', type: 'text' as const, body, replyId: null, waMediaId: null }
  return (await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))).conversationId
}

/** What was sent during the current test. */
const sentBodies = (s: FakeSender) => s.sent.slice(sentBefore).map((m) => ('body' in m ? m.body : ''))

describe('the agent takes an order', () => {
  it('quotes from the catalog, the zone price and the chosen method, whatever the model would say', async () => {
    const conversationId = await customerWrites('584121000101', 'Quiero 2 recargas de 19 litros')
    model.calls = [{ name: 'quote_order', args: { ...ORDER, unitPrice: 0.01 } }]
    await agent().answer(a.tenantId, conversationId)
    expect(model.results[0]).toMatchObject({
      lines: [{ product: 'Recarga 19L', quantity: 2, unitUsd: '0.90', lineUsd: '1.80', lineBs: '1598.62' }],
      delivery: { usd: '1.00' },
      totalUsd: '2.80',
      paymentMethod: 'Pago móvil',
      amountToPay: 'Bs 2.486,74',
    })
    expect(await t.db.select().from(orders)).toHaveLength(0)
  })

  it('saves nothing until the customer confirms, and refuses what the business does not have or accept', async () => {
    const conversationId = await customerWrites('584121000102', 'Quiero hielo')
    model.calls = [
      { name: 'place_order', args: { ...ORDER, customerConfirmed: false } },
      { name: 'quote_order', args: { ...ORDER, items: [{ product: 'Bolsa de Hielo', quantity: 1 }] } },
      { name: 'quote_order', args: { ...ORDER, items: [{ product: 'Helado de mango', quantity: 1 }] } },
      { name: 'quote_order', args: { ...ORDER, address: undefined } },
      { name: 'quote_order', args: { ...ORDER, paymentMethod: 'Zelle' } },
      { name: 'quote_order', args: { ...ORDER, paymentMethod: undefined } },
    ]
    await agent().answer(a.tenantId, conversationId)
    expect(model.results.map((r) => (r as { error?: string }).error)).toEqual([
      expect.stringContaining('not confirmed'),
      expect.stringContaining('not available'),
      expect.stringContaining('not in the catalog'),
      expect.stringContaining('exact address'),
      expect.stringContaining('not a payment method'),
      expect.stringContaining('how they will pay'),
    ])
    expect(await t.db.select().from(orders)).toHaveLength(0)
  })

  it('a confirmed order is saved once, waits for the payment, and the server sends its payment data', async () => {
    const conversationId = await customerWrites('584121000103', 'Sí, confirmo')
    placed.conversationId = conversationId
    model.calls = [
      { name: 'place_order', args: { ...ORDER, customerConfirmed: true } },
      { name: 'place_order', args: { ...ORDER, customerConfirmed: true } },
    ]
    await agent().answer(a.tenantId, conversationId)
    const saved = await t.db.select().from(orders).where(eq(orders.conversationId, conversationId))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ status: 'awaiting_payment', customerName: 'María Pérez', fulfillment: 'delivery', zone: 'centro', subtotalCents: 180, deliveryCents: 100 })
    expect(saved[0]!.paymentMethodId).not.toBeNull()
    expect(saved[0]!.code).toMatch(/^P-[2-9A-Z]{6}$/)
    expect(await t.db.select({ name: orderLines.name, quantity: orderLines.quantity, unitPriceCents: orderLines.unitPriceCents }).from(orderLines)).toEqual([{ name: 'Recarga 19L', quantity: 2, unitPriceCents: 90 }])
    // The model never learns the code: customers are not given it.
    expect(model.results[0]).toMatchObject({ saved: true })
    expect(JSON.stringify(model.results)).not.toContain(saved[0]!.code)

    // One message, written by the server instead of the model's words.
    expect(sentBodies(sender)).toEqual([
      '¡Perfecto, María! Para registrar tu pedido, por favor realiza el pago por Pago móvil:\n\n' +
        'Banco: 0134 · Banesco\nTeléfono: 0414-1234567\nRIF: J-50472711-3\nMonto a pagar: Bs 2.486,74\n\n' +
        'Cuando pagues, envíanos por aquí el capture del comprobante, con el número de referencia visible.',
    ])
    const [conversation] = await t.db.select({ reason: conversations.handoffReason }).from(conversations).where(eq(conversations.id, conversationId))
    expect(conversation!.reason).toBe('order_placed')
  })

  it('paid in cash, the order goes straight to a person and no receipt is asked for', async () => {
    const conversationId = await customerWrites('584121000104', 'Confirmo, pago en efectivo')
    placed.cashConversationId = conversationId
    model.calls = [{ name: 'place_order', args: { ...ORDER, fulfillment: 'pickup', paymentMethod: 'efectivo en dolares', customerConfirmed: true } }]
    await agent().answer(a.tenantId, conversationId)
    const [saved] = await t.db.select().from(orders).where(eq(orders.conversationId, conversationId))
    expect(saved).toMatchObject({ status: 'payment_review', deliveryCents: 0 })
    expect(sentBodies(sender)).toEqual(['¡Perfecto, María! Tu pedido se paga con Efectivo en dólares:\n\nMonto a pagar: USD 1,80\n\nLo revisamos y te confirmamos en breve.'])
  })
})

describe('the payment receipt', () => {
  const collector = (downloader: MediaDownloader) => new ReceiptCollector(t.db, credentials, downloader, new BotDelivery(t.db, credentials, sender), silentLog)
  const image = (conversationId: string, n: number) => ({ conversationId, waMessageId: `wamid.receipt.${n}`, timestamp: NOW, type: 'image', waMediaId: `media-${n}` })

  it('an image while the order waits for payment is kept with it, and the customer is told', async () => {
    const downloader = new FakeDownloader()
    expect(await collector(downloader).takes(a.tenantId, image(placed.conversationId, 1))).toBe(true)
    const [order] = await t.db.select().from(orders).where(eq(orders.conversationId, placed.conversationId))
    expect(order!.status).toBe('payment_review')
    expect(await t.db.select().from(orderReceipts).where(eq(orderReceipts.orderId, order!.id))).toHaveLength(1)
    expect(downloader.asked).toEqual(['media-1'])
    expect(sentBodies(sender)).toEqual(['¡Recibimos tu comprobante! Lo revisaremos y te confirmaremos en breve.'])
  })

  it('text, or an image where no order waits for payment, is not a receipt', async () => {
    const downloader = new FakeDownloader()
    expect(await collector(downloader).takes(a.tenantId, { ...image(placed.conversationId, 2), type: 'text', waMediaId: null })).toBe(false)
    const other = await customerWrites('584121000105', 'Hola')
    expect(await collector(downloader).takes(a.tenantId, image(other, 3))).toBe(false)
    expect(downloader.asked).toEqual([])
  })
})

describe('orders for the team', () => {
  const call = async (userId: string, method: 'GET' | 'PUT' | 'POST', path: string, payload?: object) =>
    app.inject({ method, url: `/api/tenants/${a.tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
  const orderOf = async (conversationId: string) => (await t.db.select().from(orders).where(eq(orders.conversationId, conversationId)))[0]!

  it('admins see every order; an agent only those of the conversations assigned to them', async () => {
    const { items } = (await call(who.laura, 'GET', '/orders')).json<{ items: { id: string; conversationId: string; lines: unknown[]; paymentMethod: unknown; receiptCount: number }[] }>()
    expect(items).toHaveLength(2)
    const card = items.find((o) => o.conversationId === placed.conversationId)!
    expect(card).toMatchObject({ lines: [{ name: 'Recarga 19L', quantity: 2, unitPriceCents: 90 }], paymentMethod: { name: 'Pago móvil', type: 'pago_movil', currency: 'VES' }, receiptCount: 1 })
    expect((await call(who.carlos, 'GET', '/orders')).json()).toEqual({ items: [] })
    expect((await call(who.carlos, 'GET', `/orders/${card.id}`)).statusCode).toBe(404)
    await seedAssignees(t.db, a.tenantId, placed.conversationId, who.carlos)
    expect((await call(who.carlos, 'GET', '/orders?status=payment_review')).json<{ items: unknown[] }>().items).toHaveLength(1)
  })

  it('the detail shows the receipts, and their file only to whoever sees the order', async () => {
    const order = await orderOf(placed.conversationId)
    const detail = (await call(who.carlos, 'GET', `/orders/${order.id}`)).json<{ receipts: { mediaId: string; mimeType: string }[] }>()
    expect(detail.receipts).toEqual([expect.objectContaining({ mimeType: 'image/jpeg', sizeBytes: 15 })])
    const file = await call(who.carlos, 'GET', `/orders/${order.id}/receipts/${detail.receipts[0]!.mediaId}`)
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('image/jpeg')
    expect(file.headers['cache-control']).toBe('private, no-store')
    expect(file.body).toBe('fake-jpeg-bytes')
    const cash = await orderOf(placed.cashConversationId)
    expect((await call(who.carlos, 'GET', `/orders/${cash.id}/receipts/${detail.receipts[0]!.mediaId}`)).statusCode).toBe(404)
  })

  it('confirming tells the customer once; the other statuses only move the order', async () => {
    const order = await orderOf(placed.conversationId)
    expect((await call(who.carlos, 'PUT', `/orders/${order.id}/status`, { status: 'confirmed' })).statusCode).toBe(400)
    expect((await call(who.carlos, 'POST', `/orders/${order.id}/confirm`)).statusCode).toBe(204)
    expect((await call(who.carlos, 'POST', `/orders/${order.id}/confirm`)).statusCode).toBe(204)
    expect(sentBodies(sender)).toEqual([
      '¡Listo, María! Tu pedido ha sido confirmado. Nos pondremos en contacto contigo para concretar el pedido y posteriormente la entrega. ¡Muchas gracias por confiar en nosotros! 😊',
    ])
    expect((await orderOf(placed.conversationId)).status).toBe('confirmed')
    expect((await call(who.carlos, 'PUT', `/orders/${order.id}/status`, { status: 'done' })).statusCode).toBe(204)
    expect((await call(who.laura, 'GET', '/orders?status=done')).json<{ items: unknown[] }>().items).toHaveLength(1)
    expect((await call(who.laura, 'PUT', `/orders/${order.id}/status`, { status: 'shipped' })).statusCode).toBe(400)
  })

  it('closing the last open order gives the conversation back to the agent', async () => {
    const handoffOf = async (conversationId: string) => (await t.db.select({ reason: conversations.handoffReason }).from(conversations).where(eq(conversations.id, conversationId)))[0]!.reason
    // Completed in the test above: its next purchase needs nobody.
    expect(await handoffOf(placed.conversationId)).toBeNull()

    // While another order of the same customer is open, a person still has work there.
    const cash = await orderOf(placed.cashConversationId)
    const [second] = await t.db
      .insert(orders)
      .values({ tenantId: a.tenantId, conversationId: placed.cashConversationId, code: 'P-SECOND', sourceKey: 'second-order', customerName: 'María Pérez', fulfillment: 'pickup', subtotalCents: 90 })
      .returning({ id: orders.id })
    expect((await call(who.laura, 'PUT', `/orders/${cash.id}/status`, { status: 'cancelled' })).statusCode).toBe(204)
    expect(await handoffOf(placed.cashConversationId)).toBe('order_placed')
    expect((await call(who.laura, 'PUT', `/orders/${second!.id}/status`, { status: 'done' })).statusCode).toBe(204)
    expect(await handoffOf(placed.cashConversationId)).toBeNull()
  })
})

describe('an order in progress', () => {
  const handoffOf = async (conversationId: string) => (await t.db.select({ reason: conversations.handoffReason }).from(conversations).where(eq(conversations.id, conversationId)))[0]!.reason
  const from = '584121000109'

  it('the agent tells how it is going, and only that', async () => {
    const conversationId = await customerWrites(from, 'Sí, confirmo')
    model.calls = [{ name: 'place_order', args: { ...ORDER, customerConfirmed: true } }]
    await agent().answer(a.tenantId, conversationId)
    expect(await handoffOf(conversationId)).toBe('order_placed')

    model = new FakeModel()
    sentBefore = sender.sent.length
    await customerWrites(from, '¿Cómo va mi pedido?')
    await agent().answer(a.tenantId, conversationId)
    const [request] = model.requests
    expect(request!.system).toContain('2 × Recarga 19L. Status: waiting for their payment')
    expect(request!.system).toContain('you only tell')
    // No catalog and no new orders while one is in progress: passing the chat on is all it can do.
    expect(request!.tools.map((tool) => tool.name)).toEqual(['hand_off_to_person'])
    expect(sentBodies(sender)).toEqual(['Listo'])
    expect(await handoffOf(conversationId)).toBe('order_placed')
  })

  it('anything else goes to a person, and from then on the agent is quiet there', async () => {
    const conversationId = await customerWrites(from, 'Quiero cambiar la dirección')
    model.calls = [{ name: 'hand_off_to_person', args: { reason: 'purchase' } }]
    await agent().answer(a.tenantId, conversationId)
    expect(await handoffOf(conversationId)).toBe('purchase')

    model = new FakeModel()
    await customerWrites(from, '¿Hola?')
    await agent().answer(a.tenantId, conversationId)
    expect(model.requests).toHaveLength(0)
  })

  it('once the order is closed the agent sells again, and still knows how that order ended', async () => {
    const conversationId = await customerWrites(from, '¿Ya salió?')
    const [order] = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.conversationId, conversationId))
    await app.inject({ method: 'PUT', url: `/api/tenants/${a.tenantId}/orders/${order!.id}/status`, headers: await bearer(who.laura), payload: { status: 'done' } })
    expect(await handoffOf(conversationId)).toBeNull()

    // Days later (after the receipt went out), the customer writes again.
    await customerWrites(from, 'Hola de nuevo')
    await agent().answer(a.tenantId, conversationId)
    const [request] = model.requests
    expect(request!.system).toContain('Status: completed')
    expect(request!.system).not.toContain('you only tell')
    expect(request!.tools.map((tool) => tool.name)).toContain('place_order')
  })
})

// Checking a payment without anybody outside: the reference its payment method asks for, never one
// that already paid another order; the same receipt file sent for two orders; less money than the
// order costs; who confirmed and when; the products taken out of the inventory once (and put back
// if the order is cancelled); and the day's close by payment method. Two companies, zero crossings.
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mediaFiles, orderLines, orderReceipts, orders, paymentMethods, productVariants, products, stockMovements } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { FakeSender, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let app: FastifyInstance
const who = { laura: '', bruno: '' }
const method = { pagoMovil: '', zelle: '', bPagoMovil: '' }
const variant = { botellon: '' }
let counter = 0

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.bruno = await seedUser(t.db, 'Bruno')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, b.tenantId, who.bruno, { role: 'admin' })
  const methods = await t.db
    .insert(paymentMethods)
    .values([
      { tenantId: a.tenantId, type: 'pago_movil', name: 'Pago móvil', sortOrder: 0 },
      { tenantId: a.tenantId, type: 'zelle', name: 'Zelle', referenceRule: 'optional', sortOrder: 1 },
      { tenantId: b.tenantId, type: 'pago_movil', name: 'Pago móvil', sortOrder: 0 },
    ])
    .returning({ id: paymentMethods.id })
  ;[method.pagoMovil, method.zelle, method.bPagoMovil] = methods.map((m) => m.id) as [string, string, string]
  const [product] = await t.db.insert(products).values({ tenantId: a.tenantId, name: 'Botellón', stockMode: 'units' }).returning({ id: products.id })
  const [row] = await t.db.insert(productVariants).values({ tenantId: a.tenantId, productId: product!.id, name: 'Botellón', sku: 'BOT-1', priceCents: 1000 }).returning({ id: productVariants.id })
  variant.botellon = row!.id
  await t.db.insert(stockMovements).values({ tenantId: a.tenantId, variantId: variant.botellon, kind: 'initial', quantity: 5, userId: who.laura })
  app = await buildTestApp(t.db, { sender: new FakeSender() })
})
afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, verb: 'GET' | 'PUT' | 'POST', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method: verb, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

/** An order waiting for its payment: botellones of our inventory and, if asked, a product of another system. */
async function placeOrder(options: { tenant?: SeededTenant; methodId?: string; botellones?: number; external?: boolean } = {}): Promise<string> {
  const tenant = options.tenant ?? a
  const n = ++counter
  const event = { kind: 'inbound_message' as const, phoneNumberId: tenant.phoneNumberId, waMessageId: `wamid.pay.${n}`, timestamp: new Date(), from: `58412400000${n}`, profileName: 'Cliente', type: 'text' as const, body: 'Hola', replyId: null, waMediaId: null }
  const { conversationId } = await withTenant(t.db, tenant.tenantId, (scope) => new IngestService().recordInbound(scope, tenant.channelAccountId, event))
  const [order] = await t.db
    .insert(orders)
    .values({ tenantId: tenant.tenantId, conversationId, code: `P-PAY${n}`, sourceKey: `pay-${n}`, customerName: 'María Pérez', fulfillment: 'pickup', paymentMethodId: options.methodId ?? method.pagoMovil, subtotalCents: 2000, deliveryCents: 0, bsPerUsd: '100.00' })
    .returning({ id: orders.id })
  const lines = [{ tenantId: tenant.tenantId, orderId: order!.id, position: 0, productRef: variant.botellon, name: 'Botellón', quantity: options.botellones ?? 2, saleUnit: 'unit' as const, unitPriceCents: 1000 }]
  if (options.external) lines.push({ ...lines[0]!, position: 1, productRef: 'p1', name: 'Recarga 19L' })
  await t.db.insert(orderLines).values(lines)
  return order!.id
}

const onHand = async () => (await t.db.select({ onHand: productVariants.onHand }).from(productVariants).where(eq(productVariants.id, variant.botellon)))[0]!.onHand
const detail = async (orderId: string) => (await call(who.laura, 'GET', `/orders/${orderId}`)).json<Record<string, unknown>>()

describe('the payment reference', () => {
  it('is at least 4 letters or digits, kept without spaces and in capitals', async () => {
    const orderId = await placeOrder()
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: '12 3', receivedAmount: '' })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: 'ab 12', receivedAmount: '0' })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: 'ab 12', receivedAmount: '20' })).statusCode).toBe(204)
    expect(await detail(orderId)).toMatchObject({ paymentReference: 'AB12', receivedAmount: '20.00' })
  })

  it('that paid one order cannot pay another of the same method; before confirming, the order says where it was used', async () => {
    const first = await placeOrder({ botellones: 1 })
    await call(who.laura, 'PUT', `/orders/${first}/payment`, { reference: '445566', receivedAmount: '' })
    expect((await call(who.laura, 'POST', `/orders/${first}/confirm`)).statusCode).toBe(200)

    const second = await placeOrder({ botellones: 1 })
    await call(who.laura, 'PUT', `/orders/${second}/payment`, { reference: '44 55 66', receivedAmount: '' })
    expect(await detail(second)).toMatchObject({ alerts: { referenceUsedIn: [expect.stringMatching(/^P-PAY/)] } })
    const refused = await call(who.laura, 'POST', `/orders/${second}/confirm`)
    expect([refused.statusCode, refused.json()]).toEqual([409, { error: 'payment_reference_used' }])
    expect(await detail(second)).toMatchObject({ status: 'awaiting_payment', confirmedAt: null })

    // Another method, or another company, may have the same number.
    const zelle = await placeOrder({ methodId: method.zelle, botellones: 1 })
    await call(who.laura, 'PUT', `/orders/${zelle}/payment`, { reference: '445566', receivedAmount: '' })
    expect((await call(who.laura, 'POST', `/orders/${zelle}/confirm`)).statusCode).toBe(200)
    const other = await placeOrder({ tenant: b, methodId: method.bPagoMovil, botellones: 0.5 })
    await t.db.delete(orderLines).where(eq(orderLines.orderId, other))
    await call(who.bruno, 'PUT', `/orders/${other}/payment`, { reference: '445566', receivedAmount: '' }, b.tenantId)
    expect((await call(who.bruno, 'POST', `/orders/${other}/confirm`, undefined, b.tenantId)).statusCode).toBe(200)

    // Nor can a sold order be given a reference that paid another one, or lose the one its method needs.
    const zelleSold = await placeOrder({ methodId: method.zelle, botellones: 1 })
    expect((await call(who.laura, 'POST', `/orders/${zelleSold}/confirm`)).statusCode).toBe(200)
    expect((await call(who.laura, 'PUT', `/orders/${zelleSold}/payment`, { reference: '445566', receivedAmount: '' })).json()).toEqual({ error: 'payment_reference_used' })
    expect((await call(who.laura, 'PUT', `/orders/${first}/payment`, { reference: '', receivedAmount: '' })).json()).toEqual({ error: 'payment_reference_required' })
  })
})

describe('what the person checking the payment is warned about', () => {
  it('the same receipt file sent for two orders', async () => {
    const [first, second] = [await placeOrder({ botellones: 1 }), await placeOrder({ botellones: 1 })]
    const content = Buffer.from('same-capture-bytes')
    const files = await t.db
      .insert(mediaFiles)
      .values([
        { tenantId: a.tenantId, waMediaId: 'media-dup-1', mimeType: 'image/jpeg', sizeBytes: content.length, content },
        { tenantId: a.tenantId, waMediaId: 'media-dup-2', mimeType: 'image/jpeg', sizeBytes: content.length, content },
      ])
      .returning({ id: mediaFiles.id })
    await t.db.insert(orderReceipts).values([
      { tenantId: a.tenantId, orderId: first, mediaId: files[0]!.id },
      { tenantId: a.tenantId, orderId: second, mediaId: files[1]!.id },
    ])
    const codeOf = async (id: string) => (await t.db.select({ code: orders.code }).from(orders).where(eq(orders.id, id)))[0]!.code
    expect(await detail(second)).toMatchObject({ alerts: { receiptUsedIn: [await codeOf(first)] } })
    expect(await detail(first)).toMatchObject({ alerts: { receiptUsedIn: [await codeOf(second)] } })
  })

  it('less money than the order costs, beyond the rounding of the rate', async () => {
    const orderId = await placeOrder({ botellones: 1 })
    // $20 at 100 Bs/$: Bs 2.000 expected.
    await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: '991100', receivedAmount: '1995' })
    expect(await detail(orderId)).toMatchObject({ expectedAmount: '2000.00', alerts: { shortBy: null } })
    await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: '991100', receivedAmount: '1500' })
    expect(await detail(orderId)).toMatchObject({ alerts: { shortBy: '500.00' } })
  })
})

describe('the inventory follows the sales', () => {
  it('confirming takes the products once; cancelling puts them back; a product of another system is not ours', async () => {
    await t.db.insert(stockMovements).values({ tenantId: a.tenantId, variantId: variant.botellon, kind: 'purchase', quantity: 10, userId: who.laura })
    const start = await onHand()
    const orderId = await placeOrder({ botellones: 3, external: true })
    await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: '700001', receivedAmount: '' })
    expect((await call(who.laura, 'POST', `/orders/${orderId}/confirm`)).json()).toEqual({ stockShortfalls: [] })
    expect(await onHand()).toBe(start - 3)
    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })
    expect(await onHand()).toBe(start - 3)
    expect(await detail(orderId)).toMatchObject({ status: 'done', confirmedBy: 'Laura' })

    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'cancelled' })
    expect(await onHand()).toBe(start)
    expect(await detail(orderId)).toMatchObject({ confirmedAt: null, confirmedBy: null })
    const moves = await t.db.select({ kind: stockMovements.kind, quantity: stockMovements.quantity }).from(stockMovements).where(and(eq(stockMovements.orderId, orderId)))
    expect(moves).toEqual([
      { kind: 'sale', quantity: -3 },
      { kind: 'return', quantity: 3 },
    ])
  })

  it('with too little in stock, the order is confirmed anyway and the person is told what was missing', async () => {
    const available = await onHand()
    const orderId = await placeOrder({ botellones: available + 2 })
    await call(who.laura, 'PUT', `/orders/${orderId}/payment`, { reference: '700002', receivedAmount: '' })
    const confirmed = await call(who.laura, 'POST', `/orders/${orderId}/confirm`)
    expect(confirmed.json()).toEqual({ stockShortfalls: [{ name: 'Botellón', missing: 2 }] })
    expect(await onHand()).toBe(0)
    expect(await detail(orderId)).toMatchObject({ status: 'confirmed' })
    // Back to stock for the next tests.
    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'cancelled' })
    expect(await onHand()).toBe(available)
  })
})

describe('the day’s close', () => {
  it('adds up the orders sold today by payment method, and only those of the company', async () => {
    const close = (await call(who.laura, 'GET', '/orders/daily-close')).json<{
      count: number
      byMethod: { paymentMethod: { name: string } | null; count: number; totalCents: number; expectedAmount: string; withoutReceived: number }[]
      orders: { code: string }[]
    }>()
    // Sold and still sold: the first reference test, the Zelle ones and nothing cancelled.
    const pago = close.byMethod.find((g) => g.paymentMethod?.name === 'Pago móvil')!
    const zelle = close.byMethod.find((g) => g.paymentMethod?.name === 'Zelle')!
    expect(pago).toMatchObject({ count: 1, totalCents: 2000, expectedAmount: '2000.00', withoutReceived: 1 })
    expect(zelle).toMatchObject({ count: 2, totalCents: 4000, expectedAmount: '40.00' })
    expect(close.count).toBe(3)

    const other = (await call(who.bruno, 'GET', '/orders/daily-close', undefined, b.tenantId)).json<{ count: number }>()
    expect(other.count).toBe(1)
    expect((await call(who.laura, 'GET', '/orders/daily-close?date=2020-01-01')).json()).toMatchObject({ date: '2020-01-01', count: 0, byMethod: [] })
    expect((await call(who.laura, 'GET', '/orders/daily-close?date=2026-13-45')).statusCode).toBe(400)
  })
})

// Sale receipts (Ajustes → Recibo): the same receipt for every company, filled with its own data.
// Completing an order issues one with the next number and sends it to the customer by WhatsApp;
// «Lo subo yo» sends the team's own picture instead; «No enviar» sends nothing. One per order,
// seen only by whoever sees the order, never by another company.
import { Resvg } from '@resvg/resvg-js'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orderLines, orders, tenants } from '../../src/db/schema/index.ts'
import type { ImageMessage } from '../../src/modules/whatsapp/cloud-api.client.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { FakeSender, buildTestApp, testCredentials } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let app: FastifyInstance
const sender = new FakeSender()
const who = { laura: '', carlos: '', bruno: '' }
let counter = 0

const PNG_SIGNATURE = '89504e47'
const tinyPng = () => new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123456"/></svg>').render().asPng()

const call = async (userId: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

/** A completed sale needs an order: one placed in a fresh conversation of company A. */
async function placeOrder(): Promise<string> {
  const n = ++counter
  const event = { kind: 'inbound_message' as const, phoneNumberId: a.phoneNumberId, waMessageId: `wamid.sale.${n}`, timestamp: new Date(), from: `58412300000${n}`, profileName: 'Cliente', type: 'text' as const, body: 'Hola', replyId: null, waMediaId: null }
  const { conversationId } = await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))
  const [order] = await t.db
    .insert(orders)
    .values({ tenantId: a.tenantId, conversationId, code: `P-SALE0${n}`, status: 'confirmed', sourceKey: `sale-${n}`, customerName: 'María Pérez', fulfillment: 'pickup', subtotalCents: 330, deliveryCents: 0, bsPerUsd: '100.00' })
    .returning({ id: orders.id })
  await t.db.insert(orderLines).values([
    { tenantId: a.tenantId, orderId: order!.id, position: 0, productRef: 'v1', name: 'Queso blanco', quantity: 0.15, saleUnit: 'kg', unitPriceCents: 1000 },
    { tenantId: a.tenantId, orderId: order!.id, position: 1, productRef: 'v2', name: 'Refresco', quantity: 2, saleUnit: 'unit', unitPriceCents: 90 },
  ])
  return order!.id
}

const images = () => sender.sent.filter((m): m is ImageMessage => 'image' in m)
const settingsFor = (mode: 'vortomi' | 'own' | 'off', extra: object = {}) => ({ mode, subtitle: 'Sucursal Centro', phone: '0412-1234567', prefix: 'emp', footer: 'Gracias', showAttendedBy: true, showPaymentReference: true, ...extra })

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  await t.db.update(tenants).set({ businessType: 'auto_parts' }).where(eq(tenants.id, a.tenantId))
  who.laura = await seedUser(t.db, 'Laura Admin')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.bruno = await seedUser(t.db, 'Bruno')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.bruno, { role: 'admin' })
  const credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAG-token-a')
  app = await buildTestApp(t.db, { sender, credentials })
})
afterAll(async () => {
  await app.close()
  await t.close()
})

describe('Ajustes → Recibo', () => {
  it('starts filled in: Vortomi makes them, the prefix from the name, the footer from the business type', async () => {
    const view = (await call(who.carlos, 'GET', '/receipt-settings')).json<{ footer: string }>()
    expect(view).toMatchObject({ mode: 'vortomi', prefix: 'E', nextCode: 'E-000001', hasLogo: false, business: { name: 'Empresa A', taxId: 'J-41234567-8' } })
    expect(view.footer).toContain('Garantía de 30 días')
  })

  it('only admins change it, and the prefix is short letters and digits', async () => {
    expect((await call(who.carlos, 'PUT', '/receipt-settings', settingsFor('vortomi'))).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', '/receipt-settings', settingsFor('vortomi', { prefix: 'A-1' }))).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', '/receipt-settings', settingsFor('vortomi'))).json()).toMatchObject({ prefix: 'EMP', nextCode: 'EMP-000001', subtitle: 'Sucursal Centro' })
  })

  it('takes a real PNG or JPEG as logo, never something else dressed as one', async () => {
    const fake = { mimeType: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') }
    expect((await call(who.laura, 'PUT', '/receipt-settings/logo', fake)).json()).toEqual({ error: 'invalid_picture' })
    const logo = { mimeType: 'image/png', data: tinyPng().toString('base64') }
    expect((await call(who.carlos, 'PUT', '/receipt-settings/logo', logo)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', '/receipt-settings/logo', logo)).json()).toMatchObject({ hasLogo: true })
  })

  it('shows how the receipt looks, as a picture', async () => {
    const preview = await call(who.laura, 'GET', '/receipt-settings/preview')
    expect(preview.headers['content-type']).toBe('image/png')
    expect(preview.rawPayload.subarray(0, 4).toString('hex')).toBe(PNG_SIGNATURE)
  })
})

describe('completing an order', () => {
  it('issues its receipt with the next number and sends it to the customer, once', async () => {
    const orderId = await placeOrder()
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/payment-reference`, { reference: ' 000123 ' })).statusCode).toBe(204)
    const before = images().length
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })).statusCode).toBe(204)
    expect((await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })).statusCode).toBe(204)

    const sent = images().slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ caption: '¡Gracias por tu compra, María! Aquí tienes tu recibo. 🧾', image: { mimeType: 'image/png', filename: 'EMP-000001.png' } })
    expect((await call(who.laura, 'GET', `/orders/${orderId}`)).json()).toMatchObject({ paymentReference: '000123', saleReceipt: { code: 'EMP-000001' } })
    const file = await call(who.laura, 'GET', `/orders/${orderId}/sale-receipt`)
    expect(file.rawPayload.subarray(0, 4).toString('hex')).toBe(PNG_SIGNATURE)
    expect((await call(who.laura, 'GET', '/receipt-settings')).json()).toMatchObject({ nextCode: 'EMP-000002' })
  })

  it('numbers follow each other, and another company never sees them', async () => {
    const orderId = await placeOrder()
    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })
    expect((await call(who.laura, 'GET', `/orders/${orderId}`)).json()).toMatchObject({ saleReceipt: { code: 'EMP-000002' } })
    expect((await call(who.bruno, 'GET', `/orders/${orderId}/sale-receipt`, undefined, b.tenantId)).statusCode).toBe(404)
    expect((await call(who.bruno, 'GET', '/receipt-settings', undefined, b.tenantId)).json()).toMatchObject({ nextCode: 'E-000001', hasLogo: false })
  })

  it('«Lo subo yo»: nothing on completing; the team uploads its own picture once and it is sent', async () => {
    await call(who.laura, 'PUT', '/receipt-settings', settingsFor('own'))
    const orderId = await placeOrder()
    const before = images().length
    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })
    expect(images()).toHaveLength(before)

    const own = { mimeType: 'image/png', data: tinyPng().toString('base64') }
    expect((await call(who.laura, 'POST', `/orders/${orderId}/sale-receipt`, own)).statusCode).toBe(204)
    expect(images().slice(before).map((m) => m.image.mimeType)).toEqual(['image/png'])
    expect((await call(who.laura, 'GET', `/orders/${orderId}`)).json()).toMatchObject({ saleReceipt: { code: null } })
    expect((await call(who.laura, 'POST', `/orders/${orderId}/sale-receipt`, own)).json()).toEqual({ error: 'receipt_already_issued' })
  })

  it('«No enviar»: completing sends nothing and takes no number', async () => {
    await call(who.laura, 'PUT', '/receipt-settings', settingsFor('off'))
    const orderId = await placeOrder()
    const before = images().length
    await call(who.laura, 'PUT', `/orders/${orderId}/status`, { status: 'done' })
    expect(images()).toHaveLength(before)
    expect((await call(who.laura, 'GET', `/orders/${orderId}`)).json()).toMatchObject({ saleReceipt: null })
    expect((await call(who.laura, 'GET', '/receipt-settings')).json()).toMatchObject({ nextCode: 'EMP-000003' })
  })
})

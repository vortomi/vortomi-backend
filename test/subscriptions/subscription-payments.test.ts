// A company reports its payments to Vortomi (documentations/18 §5; mockups web-39 and web-40): each
// method's own form and checks, within the last 7 days, one in review at a time, a private receipt,
// months fixed once something is paid, a rejected payment corrected and sent again; and a payment
// in review that covers the whole debt keeps the company working.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { companySubscriptions, platformExchangeRates, subscriptionCharges, subscriptionPayments } from '../../src/db/schema/index.ts'
import type { MediaFile } from '../../src/modules/chat-media/media-store.ts'
import type { PaymentProofStore } from '../../src/modules/subscriptions/payment-proof-store.ts'
import { setBillingEnforcement } from '../../src/modules/subscriptions/billing-enforcement.ts'
import { addDays, caracasToday } from '../../src/modules/subscriptions/subscription-rules.ts'
import { companyIsActive } from '../../src/modules/tenancy/company-status.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

/** Stands in for the private bucket: what was kept, by key. */
class FakeProofStore implements PaymentProofStore {
  readonly files = new Map<string, MediaFile>()
  put(key: string, file: MediaFile): Promise<void> {
    this.files.set(key, file)
    return Promise.resolve()
  }
  get(key: string): Promise<MediaFile> {
    const file = this.files.get(key)
    return file ? Promise.resolve(file) : Promise.reject(new Error('missing'))
  }
}

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const proofs = new FakeProofStore()
const who = { yornel: '', laura: '', carlos: '', rosa: '' }
const method = { pagoMovil: '', zelle: '', paypal: '', euros: '' }
const today = caracasToday()

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')
const proof = { mimeType: 'image/png', data: PNG }

const base = { instructions: '', referenceRule: 'required', receiptRule: 'required', isActive: true }
const pagoMovilMethod = {
  ...base,
  type: 'pago_movil',
  name: 'Pago móvil Banesco',
  fields: [{ kind: 'bank', label: 'Banco', value: '0134 · Banesco', copyable: true }],
}

/** A pago móvil of the whole debt (225,15 $ at 410,55 Bs/$), as the panel sends it. */
const pagoMovil = (overrides: object = {}) => ({
  methodId: method.pagoMovil,
  months: 3,
  paidOn: today,
  amount: '92435.33',
  reference: '000451287',
  payer: { bank: '0102 · Banco de Venezuela', phone: '0414-1234567', document: 'V-18456789' },
  proof,
  ...overrides,
})

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.carlos, { role: 'agent' })
  who.rosa = await seedUser(t.db, 'Rosa')
  await seedMembership(t.db, b.tenantId, who.rosa, { role: 'admin' })
  app = await buildTestApp(t.db, { paymentProofs: proofs })

  const console_ = async (path: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/platform${path}`, headers: await bearer(who.yornel, { aal: 'aal2' }), payload })
  const plan = (await console_('/plans', { name: 'Vortomi', description: '', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, benefits: [], isActive: true })).json<{ id: string }>().id
  method.pagoMovil = (await console_('/payment-methods', pagoMovilMethod)).json<{ id: string }>().id
  method.zelle = (await console_('/payment-methods', { ...base, type: 'zelle', name: 'Zelle', fields: [], receiptRule: 'optional' })).json<{ id: string }>().id
  method.paypal = (await console_('/payment-methods', { ...base, type: 'paypal', name: 'PayPal', fields: [], receiptRule: 'optional' })).json<{ id: string }>().id
  method.euros = (await console_('/payment-methods', { ...base, type: 'cash_eur', name: 'Euros', fields: [], referenceRule: 'none', receiptRule: 'none' })).json<{ id: string }>().id
  await t.db.insert(platformExchangeRates).values({ rate: '410.55000000', effectiveDate: addDays(today, -30), source: 'manual', changedBy: who.yornel })
  // Each company chose the plan, 3 months: it owes 225,15 $.
  for (const [tenantId, userId] of [[a.tenantId, who.laura], [b.tenantId, who.rosa]] as const) {
    await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription`, headers: await bearer(userId), payload: { planId: plan, months: 3 } })
  }
})

afterEach(() => setBillingEnforcement(false))

afterAll(async () => {
  await app.close()
  await t.close()
})

const send = async (payload: object, userId = who.laura, tenantId = a.tenantId) =>
  app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/subscription/payments`, headers: await bearer(userId), payload })
const company = async (path: string, userId = who.laura, tenantId = a.tenantId) =>
  app.inject({ method: 'GET', url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId) })

interface Payment {
  id: string
  status: string
  amountUsdCents: number
  reference: string | null
  currency: string
  hasProof: boolean
}

describe('the methods a company pays with', () => {
  it('are Vortomi’s visible ones, except those without a rate (euros); only for owners and admins', async () => {
    const items = (await company('/subscription/methods')).json<{ items: { name: string; currency: string }[] }>().items
    expect(items.map((m) => m.name)).toEqual(['Pago móvil Banesco', 'Zelle', 'PayPal'])
    expect(items[0]).toMatchObject({ currency: 'VES' })
    expect((await company('/subscription/methods', who.carlos)).json()).toEqual({ error: 'admin_required' })
  })
})

describe('each method’s form', () => {
  it('pago móvil: bank of the list, phone and ID with their format, a reference of digits', async () => {
    expect((await send(pagoMovil({ payer: { bank: '9999 · Otro', phone: '0414-1234567', document: 'V-18456789' } }))).json()).toEqual({ error: 'invalid_bank' })
    expect((await send(pagoMovil({ payer: { ...pagoMovil().payer, phone: '0414-12345' } }))).json()).toEqual({ error: 'invalid_phone' })
    expect((await send(pagoMovil({ payer: { ...pagoMovil().payer, document: '18456789' } }))).json()).toEqual({ error: 'invalid_document' })
    expect((await send(pagoMovil({ reference: 'REF-4512' }))).json()).toEqual({ error: 'invalid_reference' })
    expect((await send(pagoMovil({ reference: '' }))).json()).toEqual({ error: 'reference_required' })
  })

  it('zelle: who sent it (name, e-mail or US phone); paypal: a 17 or 19 character ID', async () => {
    const zelle = { methodId: method.zelle, months: 3, paidOn: today, amount: '225.15', reference: 'Q7K2X9M4P', proof: null }
    expect((await send({ ...zelle, payer: { senderName: 'Leopoldo Perez', senderContact: 'not-an-email' } })).json()).toEqual({ error: 'invalid_senderContact' })
    expect((await send({ ...zelle, payer: { senderName: 'L', senderContact: 'leo@gmail.com' } })).json()).toEqual({ error: 'invalid_senderName' })
    const paypal = { methodId: method.paypal, months: 3, paidOn: today, amount: '225.15', payer: { senderEmail: 'leo@gmail.com' }, proof: null }
    expect((await send({ ...paypal, reference: '8MC585209K746392' })).json()).toEqual({ error: 'invalid_reference' })
  })

  it('within the last 7 days, never in the future; at most 2 decimals; a method without a rate is refused', async () => {
    expect((await send(pagoMovil({ paidOn: addDays(today, 1) }))).json()).toEqual({ error: 'payment_date_future' })
    expect((await send(pagoMovil({ paidOn: addDays(today, -8) }))).json()).toEqual({ error: 'payment_date_too_old' })
    expect((await send(pagoMovil({ amount: '92435.333' }))).json()).toEqual({ error: 'invalid_request' })
    expect((await send(pagoMovil({ methodId: method.euros }))).json()).toEqual({ error: 'method_unavailable' })
  })

  it('the receipt: required when the method says so, and the file it says it is', async () => {
    expect((await send(pagoMovil({ proof: null }))).json()).toEqual({ error: 'proof_required' })
    const fake = { mimeType: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') }
    expect((await send(pagoMovil({ proof: fake }))).json()).toEqual({ error: 'invalid_proof' })
  })

  it('only owners and admins report', async () => {
    expect((await send(pagoMovil(), who.carlos)).json()).toEqual({ error: 'admin_required' })
  })
})

describe('a payment reported', () => {
  let paymentId = ''

  it('is kept in review, in dollars at Vortomi’s rate, with its receipt private', async () => {
    const sent = await send(pagoMovil({ reference: '000 451 287' }))
    expect(sent.statusCode).toBe(201)
    const payment = sent.json<{ payment: Payment }>().payment
    paymentId = payment.id
    expect(payment).toMatchObject({ status: 'in_review', currency: 'VES', amountUsdCents: 22515, reference: '000451287', hasProof: true })
    expect(proofs.files.has(`${a.tenantId}/${paymentId}`)).toBe(true)
  })

  it('covers the whole debt: the company works as if it owed nothing, even past its date', async () => {
    await t.db.update(companySubscriptions).set({ nextDueOn: addDays(today, -3) }).where(eq(companySubscriptions.tenantId, a.tenantId))
    setBillingEnforcement(true)
    const view = (await company('/subscription')).json<{ subscription: { state: string; inReview: { id: string } } }>().subscription
    expect(view.state).toBe('in_review')
    expect(view.inReview.id).toBe(paymentId)
    expect((await company('/payment-methods')).statusCode).toBe(200)
    expect(await companyIsActive(t.db)(a.tenantId)).toBe(true)
  })

  it('one at a time: nothing else while it is in review, and it cannot be changed', async () => {
    expect((await send(pagoMovil({ reference: '000451288' }))).json()).toEqual({ error: 'payment_in_review' })
    const edit = await app.inject({ method: 'PUT', url: `/api/tenants/${a.tenantId}/subscription/payments/${paymentId}`, headers: await bearer(who.laura), payload: pagoMovil() })
    expect(edit.json()).toEqual({ error: 'payment_not_editable' })
  })

  it('its reference never pays twice with the same method, not even for another company', async () => {
    expect((await send(pagoMovil({ reference: '000451287' }), who.rosa, b.tenantId)).json()).toEqual({ error: 'subscription_reference_used' })
  })

  it('the company reads its receipt and its payments; another company does not', async () => {
    const file = await company(`/subscription/payments/${paymentId}/proof`)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.rawPayload.equals(Buffer.from(PNG, 'base64'))).toBe(true)
    expect((await company(`/subscription/payments/${paymentId}/proof`, who.rosa, b.tenantId)).json()).toEqual({ error: 'payment_not_found' })
    expect((await company('/subscription/payments')).json<{ items: Payment[] }>().items.map((p) => p.id)).toEqual([paymentId])
  })

  it('rejected, it is corrected and sent again, keeping its receipt', async () => {
    await t.db.update(subscriptionPayments).set({ status: 'rejected', rejectionReason: 'reference_not_found' }).where(eq(subscriptionPayments.id, paymentId))
    // Rejected: the dates count again, and the company is past its own.
    setBillingEnforcement(true)
    expect((await company('/payment-methods')).json()).toEqual({ error: 'company_unpaid' })
    const fixed = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${a.tenantId}/subscription/payments/${paymentId}`,
      headers: await bearer(who.laura),
      payload: pagoMovil({ reference: '000451289', proof: undefined }),
    })
    expect(fixed.json<{ payment: Payment & { rejectionReason: string | null } }>().payment).toMatchObject({ status: 'in_review', reference: '000451289', hasProof: true, rejectionReason: null })
    expect((await company('/payment-methods')).statusCode).toBe(200)
  })

  it('a company reads only its own payments, and writes none', async () => {
    const seen = await withTenant(t.db, b.tenantId, ({ tx }) => tx.select({ id: subscriptionPayments.id }).from(subscriptionPayments))
    expect(seen).toEqual([])
    await expect(withTenant(t.db, a.tenantId, ({ tx }) => tx.update(subscriptionPayments).set({ status: 'approved' }))).rejects.toThrow()
  })
})

describe('the months of a charge', () => {
  it('change while nothing of it is paid, and are then fixed', async () => {
    const zelle = { methodId: method.zelle, paidOn: today, reference: 'ZX12345', payer: { senderName: 'Rosa Gil', senderContact: '+1 (305) 555-1234' }, proof: null }
    const sent = await send({ ...zelle, months: 6, amount: '426.60' }, who.rosa, b.tenantId)
    expect(sent.statusCode).toBe(201)
    const [charge] = await t.db.select({ months: subscriptionCharges.months, amountCents: subscriptionCharges.amountCents }).from(subscriptionCharges).where(eq(subscriptionCharges.tenantId, b.tenantId))
    expect(charge).toEqual({ months: 6, amountCents: 42660 })
    // Part of it paid (stage 4 does this when it approves): the months cannot move any more.
    await t.db.update(subscriptionCharges).set({ paidCents: 10000 }).where(eq(subscriptionCharges.tenantId, b.tenantId))
    await t.db.update(subscriptionPayments).set({ status: 'approved' }).where(eq(subscriptionPayments.tenantId, b.tenantId))
    expect((await send({ ...zelle, reference: 'ZX12346', months: 3, amount: '100' }, who.rosa, b.tenantId)).json()).toEqual({ error: 'months_fixed' })
  })
})

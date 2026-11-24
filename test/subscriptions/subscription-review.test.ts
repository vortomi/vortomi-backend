// The console reviews the payments companies report (documentations/18 §6–§7; mockup web-41):
// approving credits what really arrived (the billing day set by the first payment, the date moved
// when a period is paid, the extra to the balance in favour, a receipt each time); rejecting says
// why. Each month's charge is made on its due day and takes the balance first.
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  companySubscriptions,
  platformActivity,
  platformExchangeRates,
  subscriptionCharges,
  subscriptionReceipts,
  walletMovements,
} from '../../src/db/schema/index.ts'
import type { MediaFile } from '../../src/modules/chat-media/media-store.ts'
import type { PaymentProofStore } from '../../src/modules/subscriptions/payment-proof-store.ts'
import { SubscriptionBillingJob } from '../../src/modules/subscriptions/subscription-billing-job.ts'
import { addMonthsOn, caracasToday, dayOfMonth } from '../../src/modules/subscriptions/subscription-rules.ts'
import { walletBalance } from '../../src/modules/subscriptions/wallet.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

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
const who = { yornel: '', laura: '', rosa: '' }
const method = { pagoMovil: '', zelle: '' }
const today = caracasToday()
const silent = { info: () => undefined, error: () => undefined }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')

const consoleCall = async (method_: 'GET' | 'POST', path: string, payload?: object, userId = who.yornel) =>
  app.inject({ method: method_, url: `/api/platform${path}`, headers: await bearer(userId, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
const companyCall = async (method_: 'GET' | 'POST', path: string, userId: string, tenantId: string, payload?: object) =>
  app.inject({ method: method_, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const pagoMovil = (amount: string, reference: string) => ({
  methodId: method.pagoMovil,
  months: 3,
  paidOn: today,
  amount,
  reference,
  payer: { bank: '0102 · Banco de Venezuela', phone: '0414-1234567', document: 'V-18456789' },
  proof: { mimeType: 'image/png', data: PNG },
})
const zelle = (amount: string, reference: string, months = 3) => ({
  methodId: method.zelle,
  months,
  paidOn: today,
  amount,
  reference,
  payer: { senderName: 'Rosa Gil', senderContact: 'rosa@gmail.com' },
  proof: null,
})

interface Row {
  id: string
  status: string
  coverage: string
  owedCents: number
  receiptNumber: number | null
}

const owed = async (tenantId: string) =>
  (await t.db.select({ amount: subscriptionCharges.amountCents, paid: subscriptionCharges.paidCents }).from(subscriptionCharges).where(eq(subscriptionCharges.tenantId, tenantId))).reduce(
    (sum, c) => sum + c.amount - c.paid,
    0,
  )

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  who.rosa = await seedUser(t.db, 'Rosa')
  await seedMembership(t.db, b.tenantId, who.rosa, { role: 'admin' })
  app = await buildTestApp(t.db, { paymentProofs: new FakeProofStore() })
  const plan = (await consoleCall('POST', '/plans', { name: 'Vortomi', description: '', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, benefits: [], isActive: true })).json<{ id: string }>().id
  const base = { instructions: '', referenceRule: 'required', isActive: true }
  method.pagoMovil = (await consoleCall('POST', '/payment-methods', { ...base, type: 'pago_movil', name: 'Pago móvil Banesco', receiptRule: 'required', fields: [] })).json<{ id: string }>().id
  method.zelle = (await consoleCall('POST', '/payment-methods', { ...base, type: 'zelle', name: 'Zelle', receiptRule: 'optional', fields: [] })).json<{ id: string }>().id
  await t.db.insert(platformExchangeRates).values({ rate: '410.55000000', effectiveDate: today, source: 'manual', changedBy: who.yornel })
  for (const [tenantId, userId] of [[a.tenantId, who.laura], [b.tenantId, who.rosa]] as const) {
    await companyCall('POST', '/subscription', userId, tenantId, { planId: plan, months: 3 })
  }
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('approving a payment that covers it all, with something extra', () => {
  let paymentId = ''

  it('waits in Pagos, oldest first, and the menu counts it', async () => {
    paymentId = (await companyCall('POST', '/subscription/payments', who.laura, a.tenantId, pagoMovil('94488.08', '000451287'))).json<{ payment: { id: string } }>().payment.id
    const rows = (await consoleCall('GET', '/subscription-payments')).json<{ items: Row[] }>().items
    expect(rows).toEqual([expect.objectContaining({ id: paymentId, status: 'in_review', coverage: 'extra', owedCents: 22515 })])
    expect((await consoleCall('GET', '/subscription-payments/pending-count')).json()).toEqual({ count: 1 })
    expect((await consoleCall('GET', '/subscription-payments', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
  })

  it('pays the period, sets the billing day and the next date, keeps the extra, and issues a receipt', async () => {
    const approved = await consoleCall('POST', `/tenants/${a.tenantId}/subscription-payments/${paymentId}/approve`, {})
    expect(approved.json<{ payment: Row }>().payment).toMatchObject({ status: 'approved', receiptNumber: 1 })
    const [sub] = await t.db.select().from(companySubscriptions).where(eq(companySubscriptions.tenantId, a.tenantId))
    expect(sub).toMatchObject({ billingDay: dayOfMonth(today), nextDueOn: addMonthsOn(today, 3, dayOfMonth(today)) })
    expect(await owed(a.tenantId)).toBe(0)
    expect(await walletBalance(t.db, a.tenantId)).toBe(500)
    const view = (await companyCall('GET', '/subscription', who.laura, a.tenantId)).json<{ subscription: { state: string; walletCents: number } }>().subscription
    expect(view).toMatchObject({ state: 'active', walletCents: 500 })
    const actions = await t.db.select({ action: platformActivity.action }).from(platformActivity).where(eq(platformActivity.tenantId, a.tenantId))
    expect(actions.map((x) => x.action)).toContain('subscription.payment_approved')
  })

  it('only once', async () => {
    expect((await consoleCall('POST', `/tenants/${a.tenantId}/subscription-payments/${paymentId}/approve`, {})).json()).toEqual({ error: 'payment_not_in_review' })
  })

  it('its receipt is a PDF the company and the console download; another company does not', async () => {
    const mine = await companyCall('GET', `/subscription/payments/${paymentId}/receipt`, who.laura, a.tenantId)
    expect(mine.headers['content-type']).toBe('application/pdf')
    expect(mine.headers['content-disposition']).toContain('Recibo-VTM-000001.pdf')
    expect(mine.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await consoleCall('GET', `/tenants/${a.tenantId}/subscription-payments/${paymentId}/receipt`)).statusCode).toBe(200)
    expect((await companyCall('GET', `/subscription/payments/${paymentId}/receipt`, who.rosa, b.tenantId)).json()).toEqual({ error: 'receipt_not_found' })
    const listed = (await companyCall('GET', '/subscription/payments', who.laura, a.tenantId)).json<{ items: { id: string; receiptNumber: number | null }[] }>().items
    expect(listed.find((p) => p.id === paymentId)?.receiptNumber).toBe(1)
  })

  it('the company reads its balance and its movements', async () => {
    const wallet = (await companyCall('GET', '/subscription/wallet', who.laura, a.tenantId)).json<{ balanceCents: number; movements: { kind: string; amountCents: number }[] }>()
    expect(wallet).toMatchObject({ balanceCents: 500, movements: [{ kind: 'excess', amountCents: 500 }] })
  })
})

describe('partial payments, other amounts and rejections', () => {
  it('a partial payment is credited and the rest is still owed', async () => {
    const id = (await companyCall('POST', '/subscription/payments', who.rosa, b.tenantId, zelle('50.00', 'ZX10001'))).json<{ payment: { id: string } }>().payment.id
    expect((await consoleCall('GET', `/subscription-payments/${id}`)).json<{ payment: Row }>().payment.coverage).toBe('partial')
    await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${id}/approve`, {})
    expect(await owed(b.tenantId)).toBe(22515 - 5000)
    const [sub] = await t.db.select({ billingDay: companySubscriptions.billingDay }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, b.tenantId))
    expect(sub!.billingDay).toBeNull()
  })

  it('rejected with a reason the company reads; then it cannot be decided again', async () => {
    const id = (await companyCall('POST', '/subscription/payments', who.rosa, b.tenantId, zelle('175.15', 'ZX10002'))).json<{ payment: { id: string } }>().payment.id
    expect((await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${id}/reject`, { reason: 'bogus' })).json()).toEqual({ error: 'invalid_request' })
    await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${id}/reject`, { reason: 'reference_not_found', note: 'No aparece en Zelle.' })
    const mine = (await companyCall('GET', '/subscription/payments', who.rosa, b.tenantId)).json<{ items: { id: string; status: string; rejectionReason: string; rejectionNote: string }[] }>().items
    expect(mine.find((p) => p.id === id)).toMatchObject({ status: 'rejected', rejectionReason: 'reference_not_found', rejectionNote: 'No aparece en Zelle.' })
    expect((await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${id}/approve`, {})).json()).toEqual({ error: 'payment_not_in_review' })
  })

  it('approved for what really arrived', async () => {
    const id = (await companyCall('POST', '/subscription/payments', who.rosa, b.tenantId, zelle('175.15', 'ZX10003'))).json<{ payment: { id: string } }>().payment.id
    await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${id}/approve`, { receivedAmount: '170.00' })
    expect(await owed(b.tenantId)).toBe(22515 - 5000 - 17000)
    const [receipt] = await t.db.select({ data: subscriptionReceipts.data }).from(subscriptionReceipts).where(eq(subscriptionReceipts.paymentId, id))
    expect(receipt!.data).toMatchObject({ receivedCents: 17000, paidBeforeCents: 5000, pendingCents: 515 })
  })
})

describe('each month’s charge', () => {
  const job = (day: string) => new SubscriptionBillingJob(t.db, silent, () => day)
  const nextDue = async () => (await t.db.select({ d: companySubscriptions.nextDueOn }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, a.tenantId)))[0]!.d

  it('is made on its due day (not before), and the balance in favour is taken from it first', async () => {
    const due = await nextDue()
    expect(await job(addMonthsOn(due, -1, dayOfMonth(today))).run()).toBe(0)
    expect(await job(due).run()).toBe(1)
    expect(await owed(a.tenantId)).toBe(7900 - 500)
    expect(await walletBalance(t.db, a.tenantId)).toBe(0)
    // Running again makes nothing more.
    expect(await job(due).run()).toBe(0)
  })

  it('a balance that covers it whole pays it, and the date moves on', async () => {
    const due = await nextDue()
    await t.db.update(subscriptionCharges).set({ paidCents: 7900 }).where(and(eq(subscriptionCharges.tenantId, a.tenantId), eq(subscriptionCharges.dueOn, due)))
    await t.db.insert(walletMovements).values({ tenantId: a.tenantId, kind: 'excess', amountCents: 10000 })
    const next = addMonthsOn(due, 1, dayOfMonth(today))
    await t.db.update(companySubscriptions).set({ nextDueOn: next }).where(eq(companySubscriptions.tenantId, a.tenantId))
    expect(await job(next).run()).toBe(1)
    expect(await walletBalance(t.db, a.tenantId)).toBe(2100)
    expect(await nextDue()).toBe(addMonthsOn(next, 1, dayOfMonth(today)))
  })
})

describe('paying ahead, with nothing owed', () => {
  it('whole, it pays the next period and moves the date; less, it waits in the balance', async () => {
    expect(await owed(a.tenantId)).toBe(0)
    const [before] = await t.db.select({ nextDueOn: companySubscriptions.nextDueOn }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, a.tenantId))
    const whole = (await companyCall('POST', '/subscription/payments', who.laura, a.tenantId, zelle('79.00', 'ZX20001', 1))).json<{ payment: { id: string } }>().payment.id
    await consoleCall('POST', `/tenants/${a.tenantId}/subscription-payments/${whole}/approve`, {})
    const [after] = await t.db.select({ nextDueOn: companySubscriptions.nextDueOn }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, a.tenantId))
    expect(after!.nextDueOn).toBe(addMonthsOn(before!.nextDueOn, 1, dayOfMonth(today)))
    const part = (await companyCall('POST', '/subscription/payments', who.laura, a.tenantId, zelle('10.00', 'ZX20002', 1))).json<{ payment: { id: string } }>().payment.id
    await consoleCall('POST', `/tenants/${a.tenantId}/subscription-payments/${part}/approve`, {})
    expect(await walletBalance(t.db, a.tenantId)).toBe(2100 + 1000)
  })
})

describe('what each company sees', () => {
  it('only its own balance and receipts, and writes none', async () => {
    const theirs = await withTenant(t.db, b.tenantId, ({ tx }) => tx.select({ id: walletMovements.id }).from(walletMovements).where(eq(walletMovements.tenantId, a.tenantId)))
    expect(theirs).toEqual([])
    const receipts = await withTenant(t.db, b.tenantId, ({ tx }) => tx.select({ n: subscriptionReceipts.number }).from(subscriptionReceipts))
    expect(receipts.length).toBeGreaterThan(0)
    await expect(withTenant(t.db, b.tenantId, ({ tx }) => tx.insert(walletMovements).values({ tenantId: b.tenantId, kind: 'excess', amountCents: 100 }))).rejects.toThrow()
    const own = await withTenant(t.db, b.tenantId, ({ tx }) =>
      tx.select({ id: subscriptionReceipts.id }).from(subscriptionReceipts).where(and(eq(subscriptionReceipts.tenantId, a.tenantId))),
    )
    expect(own).toEqual([])
  })
})

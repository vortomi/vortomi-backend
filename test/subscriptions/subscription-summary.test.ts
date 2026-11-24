// Suscripciones → Resumen (documentations/18; mockup web-51): income is what the approved payments
// really brought, on the day they were paid, bolívares at each payment's rate; what each month
// brings; what is owed; Cobros' totals per company; a company's history; the file for Excel.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformExchangeRates, tenants } from '../../src/db/schema/index.ts'
import type { MediaFile } from '../../src/modules/chat-media/media-store.ts'
import type { PaymentProofStore } from '../../src/modules/subscriptions/payment-proof-store.ts'
import { caracasToday } from '../../src/modules/subscriptions/subscription-rules.ts'
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
    return Promise.resolve(this.files.get(key)!)
  }
}

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { yornel: '', laura: '', rosa: '' }
const method = { pagoMovil: '', zelle: '' }
const today = caracasToday()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')

const consoleCall = async (method_: 'GET' | 'POST', path: string, payload?: object, userId = who.yornel) =>
  app.inject({ method: method_, url: `/api/platform${path}`, headers: await bearer(userId, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
const companyCall = async (method_: 'GET' | 'POST', path: string, userId: string, tenantId: string, payload?: object) =>
  app.inject({ method: method_, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

interface Summary {
  income: { thisMonthCents: number; previousMonthCents: number; periodCents: number; periodVes: string; periodCount: number; firstPaidOn: string | null }
  recurringCents: number
  owedCents: number
  companies: Record<string, number>
  review: { count: number; cents: number }
  buckets: { key: string; cents: number; count: number }[]
  byMethod: { methodName: string; currency: string; cents: number; ves: string; count: number }[]
  recent: { tenantName: string; receivedCents: number; receiptNumber: number | null }[]
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  who.rosa = await seedUser(t.db, 'Rosa')
  await seedMembership(t.db, b.tenantId, who.rosa, { role: 'admin' })
  // A name Excel would run as a formula: the file must keep it as text.
  await t.db.update(tenants).set({ name: '=Rosa Gil' }).where(eq(tenants.id, b.tenantId))
  app = await buildTestApp(t.db, { paymentProofs: new FakeProofStore() })
  const plan = (await consoleCall('POST', '/plans', { name: 'Vortomi', description: '', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, benefits: [], isActive: true })).json<{ id: string }>().id
  const base = { instructions: '', referenceRule: 'required', isActive: true }
  method.pagoMovil = (await consoleCall('POST', '/payment-methods', { ...base, type: 'pago_movil', name: 'Pago móvil Banesco', receiptRule: 'required', fields: [] })).json<{ id: string }>().id
  method.zelle = (await consoleCall('POST', '/payment-methods', { ...base, type: 'zelle', name: 'Zelle', receiptRule: 'optional', fields: [] })).json<{ id: string }>().id
  await t.db.insert(platformExchangeRates).values({ rate: '410.55000000', effectiveDate: today, source: 'manual', changedBy: who.yornel })
  await companyCall('POST', '/subscription', who.laura, a.tenantId, { planId: plan, months: 3 })
  await companyCall('POST', '/subscription', who.rosa, b.tenantId, { planId: plan, months: 1 })

  // La Campiña pays its 3 months in bolívares (225,15 $ at 410,55); Rosa pays half of its month by Zelle.
  const pm = await companyCall('POST', '/subscription/payments', who.laura, a.tenantId, {
    methodId: method.pagoMovil,
    months: 3,
    paidOn: today,
    amount: '92435.33',
    reference: '000451287',
    payer: { bank: '0102 · Banco de Venezuela', phone: '0414-1234567', document: 'V-18456789' },
    proof: { mimeType: 'image/png', data: PNG },
  })
  await consoleCall('POST', `/tenants/${a.tenantId}/subscription-payments/${pm.json<{ payment: { id: string } }>().payment.id}/approve`, {})
  const z = await companyCall('POST', '/subscription/payments', who.rosa, b.tenantId, {
    methodId: method.zelle,
    months: 1,
    paidOn: today,
    amount: '40.00',
    reference: 'ZX40001',
    payer: { senderName: 'Rosa Gil', senderContact: 'rosa@gmail.com' },
    proof: null,
  })
  // What really arrived was 39,50 $: that is the income, not the 40 reported.
  await consoleCall('POST', `/tenants/${b.tenantId}/subscription-payments/${z.json<{ payment: { id: string } }>().payment.id}/approve`, { receivedAmount: '39.50' })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('Resumen', () => {
  it('counts what really arrived, on the day it was paid, bolívares at their own rate', async () => {
    const s = (await consoleCall('GET', '/subscriptions/summary?period=month')).json<Summary>()
    expect(s.income).toMatchObject({ thisMonthCents: 22515 + 3950, previousMonthCents: 0, periodCents: 26465, periodVes: '92435.33', periodCount: 2, firstPaidOn: today })
    expect(s.buckets.find((x) => x.key === today)).toEqual({ key: today, cents: 26465, count: 2 })
    expect(s.byMethod).toEqual([
      { methodName: 'Pago móvil Banesco', currency: 'VES', cents: 22515, ves: '92435.33', count: 1 },
      { methodName: 'Zelle', currency: 'USD', cents: 3950, ves: '0.00', count: 1 },
    ])
  })

  it('a year has its 12 months; what is owed and what each month brings', async () => {
    const s = (await consoleCall('GET', '/subscriptions/summary?period=year')).json<Summary>()
    expect(s.buckets).toHaveLength(12)
    expect(s.buckets[0]!.key).toBe(`${today.slice(0, 4)}-01`)
    // Rosa still owes 39,50 $ of her month; La Campiña paid its 3 months: 225,15 / 3 = 75,05 $ a month.
    expect(s.owedCents).toBe(3950)
    expect(s.recurringCents).toBe(7505)
    expect(s.companies).toMatchObject({ upToDate: 1, awaitingFirst: 1 })
    expect(s.recent.map((r) => r.receivedCents).sort()).toEqual([22515, 3950].sort())
    expect(s.review).toEqual({ count: 0, cents: 0 })
  })

  it('Cobros carries each company’s total and its last payment', async () => {
    const rows = (await consoleCall('GET', '/subscriptions')).json<{ items: { tenantId: string; paidTotalCents: number; paymentsCount: number; lastPaidOn: string | null; lastPaidCents: number | null }[] }>().items
    expect(rows.find((r) => r.tenantId === a.tenantId)).toMatchObject({ paidTotalCents: 22515, paymentsCount: 1, lastPaidOn: today, lastPaidCents: 22515 })
    expect(rows.find((r) => r.tenantId === b.tenantId)).toMatchObject({ paidTotalCents: 3950, paymentsCount: 1 })
  })

  it('a company’s history: each payment, until when it paid, its receipt', async () => {
    const h = (await consoleCall('GET', `/tenants/${a.tenantId}/subscription/history`)).json<{ totalCents: number; count: number; items: { months: number; coversTo: string | null; receiptNumber: number | null }[] }>()
    expect(h).toMatchObject({ totalCents: 22515, count: 1 })
    expect(h.items[0]?.months).toBe(3)
    expect(typeof h.items[0]?.receiptNumber).toBe('number')
    expect(h.items[0]!.coversTo).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('the file for Excel: «;», decimal commas, accents, and no formula ever', async () => {
    const res = await consoleCall('GET', '/subscriptions/income.csv?period=all')
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.body.replace(String.fromCharCode(0xfeff), '').trim().split('\r\n')
    expect(lines[0]).toBe('Fecha del pago;Empresa;Meses;Método;Referencia;Moneda;Monto;Tasa (Bs/$);Monto en dólares;Recibo')
    expect(lines).toHaveLength(3)
    expect(lines.find((l) => l.includes('Pago móvil'))).toContain('92435,33;410,55;225,15;VTM-')
    expect(lines.find((l) => l.includes('Zelle'))).toContain(";'=Rosa Gil;")
  })

  it('only the console reads it', async () => {
    expect((await consoleCall('GET', '/subscriptions/summary', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await consoleCall('GET', '/subscriptions/income.csv', undefined, who.laura)).statusCode).toBe(403)
  })
})

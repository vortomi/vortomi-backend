// «Métodos de pago» over HTTP: per company, admins create, change, hide and reorder them, anyone in
// it reads them; the Venezuelan data has its format; cash takes no proof; and what the agent offers.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { paymentText } from '../../src/modules/agent/agent-prompt.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})
afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT', path = '', payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}/payment-methods${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const pagoMovil = {
  type: 'pago_movil',
  name: ' Pago móvil Banesco ',
  fields: [
    { kind: 'bank', label: 'Banco', value: '0134 · Banesco', copyable: true },
    { kind: 'phone', label: 'Teléfono', value: '0414-1234567', copyable: true },
    { kind: 'document', label: 'RIF', value: 'J-50472711-3', copyable: true },
  ],
  instructions: 'Paga el monto exacto.',
  referenceRule: 'required',
  receiptRule: 'required',
  isActive: true,
}
const cash = { type: 'cash_usd', name: 'Efectivo en dólares', fields: [], instructions: 'Al recibir el pedido.', referenceRule: 'none', receiptRule: 'none', isActive: true }
const ids = { pagoMovil: '', cash: '' }

describe('payment methods', () => {
  it('an admin creates them for their company only; the currency follows the type; new ones go last', async () => {
    const created = await call(who.laura, 'POST', '', pagoMovil)
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Pago móvil Banesco', currency: 'VES', sortOrder: 0, isActive: true })
    ids.pagoMovil = created.json<{ id: string }>().id
    const second = await call(who.laura, 'POST', '', cash)
    expect(second.json()).toMatchObject({ currency: 'USD', sortOrder: 1 })
    ids.cash = second.json<{ id: string }>().id
    expect((await call(who.carlos, 'GET')).json<{ items: { id: string }[] }>().items.map((m) => m.id)).toEqual([ids.pagoMovil, ids.cash])
    expect((await call(who.pedro, 'GET', '', undefined, b.tenantId)).json()).toEqual({ items: [] })
  })

  it('agents cannot change them, and nobody changes another company’s', async () => {
    expect((await call(who.carlos, 'POST', '', pagoMovil)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.pedro, 'PUT', `/${ids.pagoMovil}`, pagoMovil, b.tenantId)).statusCode).toBe(404)
  })

  it('bank, phone and document must have their format; cash takes no reference or receipt', async () => {
    const withField = (field: object) => ({ ...pagoMovil, fields: [field] })
    expect((await call(who.laura, 'POST', '', withField({ kind: 'bank', label: 'Banco', value: 'Banesco', copyable: true }))).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '', withField({ kind: 'bank', label: 'Banco', value: '9999 · Falso', copyable: true }))).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '', withField({ kind: 'phone', label: 'Teléfono', value: '0212-1234567', copyable: true }))).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '', withField({ kind: 'document', label: 'RIF', value: 'J-1234567', copyable: true }))).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '', { ...pagoMovil, fields: Array.from({ length: 13 }, () => ({ label: 'Dato', value: 'x', copyable: false })) })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '', { ...cash, receiptRule: 'optional' })).statusCode).toBe(400)
    for (const value of ['V-12345678', 'E-1234567', 'V-12345678-9', 'G-20000001-4', 'P-AB123456']) {
      expect((await call(who.laura, 'PUT', `/${ids.pagoMovil}`, withField({ kind: 'document', label: 'Cédula', value, copyable: true }))).statusCode).toBe(200)
    }
  })

  it('hidden instead of deleted, and reordered as a whole', async () => {
    expect((await call(who.laura, 'PUT', `/${ids.cash}`, { ...cash, isActive: false })).json()).toMatchObject({ isActive: false })
    expect((await call(who.laura, 'PUT', '/order', { ids: [ids.cash] })).json()).toEqual({ error: 'order_mismatch' })
    const reordered = (await call(who.laura, 'PUT', '/order', { ids: [ids.cash, ids.pagoMovil] })).json<{ items: { id: string; sortOrder: number }[] }>()
    expect(reordered.items.map((m) => [m.id, m.sortOrder])).toEqual([
      [ids.cash, 0],
      [ids.pagoMovil, 1],
    ])
  })
})

describe('what the agent offers', () => {
  it('only names and currencies, never the data', () => {
    expect(paymentText(undefined)).toContain('a person tells the customer how to pay')
    const text = paymentText([{ id: 'x', type: 'pago_movil', name: 'Pago móvil', currency: 'VES', fields: [{ kind: 'phone', label: 'Teléfono', value: '0414-1234567', copyable: true }], instructions: '', referenceRule: 'required', receiptRule: 'required', isActive: true, sortOrder: 0 }])
    expect(text).toContain('Pago móvil (in bolívares)')
    expect(text).not.toContain('0414')
    const zelle = { id: 'z', type: 'zelle' as const, name: 'Zelle', currency: 'USD' as const, fields: [], instructions: '', referenceRule: 'required' as const, receiptRule: 'required' as const, isActive: true, sortOrder: 1 }
    expect(text).toContain('accepts only')
    expect(paymentText([{ ...zelle, name: 'Pago móvil', type: 'pago_movil', currency: 'VES' }, zelle])).toContain('offer only these')
  })
})

// Where companies pay Vortomi (console → Suscripciones → Métodos de pago): only super admins with
// the second factor reach it, with the same rules as a company's own methods, and no company can
// read Vortomi's table.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { paymentMethods, platformPaymentMethods } from '../../src/db/schema/index.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let company: SeededTenant
const who = { yornel: '', laura: '' }

const pagoMovil = {
  type: 'pago_movil',
  name: 'Pago móvil Banesco',
  fields: [
    { kind: 'bank', label: 'Banco', value: '0134 · Banesco', copyable: true },
    { kind: 'phone', label: 'Teléfono', value: '0414-5550101', copyable: true },
    { kind: 'document', label: 'RIF', value: 'J-41234567-8', copyable: true },
  ],
  instructions: 'Paga el monto exacto de tu plan.',
  referenceRule: 'required',
  receiptRule: 'optional',
  isActive: true,
}
const zelle = { ...pagoMovil, type: 'zelle', name: 'Zelle', fields: [{ kind: 'text', label: 'Correo', value: 'pagos@vortomi.com', copyable: true }] }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a: company } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, company.tenantId, who.laura, { role: 'admin' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PUT'
const console_ = async (method: Method, path: string, payload?: object, userId = who.yornel, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal }), ...(payload ? { payload } : {}) })

interface View {
  id: string
  name: string
  currency: string
  isActive: boolean
  sortOrder: number
}

describe('who reaches them', () => {
  it('only a super admin, and only with the second factor', async () => {
    expect((await console_('GET', '/payment-methods', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('POST', '/payment-methods', pagoMovil, who.yornel, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
  })
})

describe('Vortomi’s payment methods', () => {
  let first = ''
  let second = ''

  it('creates them last in the order, the currency following the type', async () => {
    const created = await console_('POST', '/payment-methods', pagoMovil)
    expect(created.statusCode).toBe(201)
    const a = created.json<View>()
    first = a.id
    expect(a).toMatchObject({ name: 'Pago móvil Banesco', currency: 'VES', sortOrder: 0, isActive: true })
    const b = (await console_('POST', '/payment-methods', zelle)).json<View>()
    second = b.id
    expect(b).toMatchObject({ currency: 'USD', sortOrder: 1 })
  })

  it('refuses what a company’s method would refuse', async () => {
    const badPhone = { ...pagoMovil, fields: [{ kind: 'phone', label: 'Teléfono', value: '12', copyable: true }] }
    expect((await console_('POST', '/payment-methods', badPhone)).json()).toEqual({ error: 'invalid_request' })
    const cashWithProof = { ...pagoMovil, type: 'cash_usd', fields: [] }
    expect((await console_('POST', '/payment-methods', cashWithProof)).json()).toEqual({ error: 'invalid_request' })
  })

  it('hides one instead of deleting it', async () => {
    const hidden = await console_('PUT', `/payment-methods/${first}`, { ...pagoMovil, isActive: false })
    expect(hidden.json<View>()).toMatchObject({ id: first, isActive: false })
    expect((await console_('PUT', '/payment-methods/00000000-0000-4000-8000-000000000000', pagoMovil)).json()).toEqual({ error: 'payment_method_not_found' })
  })

  it('reorders them only with every method once', async () => {
    const reordered = (await console_('PUT', '/payment-methods/order', { ids: [second, first] })).json<{ items: View[] }>()
    expect(reordered.items.map((m) => m.id)).toEqual([second, first])
    expect((await console_('PUT', '/payment-methods/order', { ids: [second] })).json()).toEqual({ error: 'order_mismatch' })
    expect((await console_('PUT', '/payment-methods/order', { ids: [second, second] })).json()).toEqual({ error: 'order_mismatch' })
    const listed = (await console_('GET', '/payment-methods')).json<{ items: View[] }>()
    expect(listed.items.map((m) => m.name)).toEqual(['Zelle', 'Pago móvil Banesco'])
  })

  it('stays apart from every company: not in their methods, not readable from their scope', async () => {
    const theirs = (await app.inject({ method: 'GET', url: `/api/tenants/${company.tenantId}/payment-methods`, headers: await bearer(who.laura) })).json<{ items: View[] }>()
    expect(theirs.items).toEqual([])
    await expect(withTenant(t.db, company.tenantId, ({ tx }) => tx.select().from(platformPaymentMethods))).rejects.toThrow()
    // The company's own table is untouched.
    expect(await t.db.select().from(paymentMethods)).toEqual([])
  })
})

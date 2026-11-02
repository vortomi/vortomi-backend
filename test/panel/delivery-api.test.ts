// «Ajustes → Delivery» over HTTP: per company, admins change it, anyone in it reads it; zone names
// are unique; and what the agent then says about delivery.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliveryText } from '../../src/modules/agent/agent-prompt.ts'
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

const call = async (userId: string, method: 'GET' | 'PUT', payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}/delivery`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const byZone = { enabled: true, mode: 'zones', flatPriceCents: 0, zones: [{ name: ' Centro ', priceCents: 100 }, { name: 'Tarapio', priceCents: 150 }] }

describe('delivery settings', () => {
  it('starts not configured', async () => {
    expect((await call(who.laura, 'GET')).json()).toEqual({ configured: false, enabled: false, mode: 'zones', flatPriceCents: 0, zones: [] })
  })

  it('an admin sets prices by zone for their company only; anyone in it reads them', async () => {
    expect((await call(who.laura, 'PUT', byZone)).json()).toMatchObject({ configured: true, enabled: true, zones: [{ name: 'Centro', priceCents: 100 }, { name: 'Tarapio', priceCents: 150 }] })
    expect((await call(who.carlos, 'GET')).json()).toMatchObject({ enabled: true, mode: 'zones' })
    expect((await call(who.pedro, 'GET', undefined, b.tenantId)).json()).toMatchObject({ configured: false })
  })

  it('agents cannot change it; zone names are unique and prices are whole cents', async () => {
    expect((await call(who.carlos, 'PUT', byZone)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', { ...byZone, zones: [{ name: 'Centro', priceCents: 1 }, { name: 'centro', priceCents: 2 }] })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', { ...byZone, flatPriceCents: 1.5 })).statusCode).toBe(400)
  })
})

describe('what the agent says about delivery', () => {
  const base = { configured: true, enabled: true, mode: 'zones' as const, flatPriceCents: 0, zones: [] }
  it('nothing set: a person confirms; off: pickup only', () => {
    expect(deliveryText(undefined, null)).toContain('a person confirms')
    expect(deliveryText({ ...base, enabled: false }, null)).toContain('does not deliver')
  })

  it('one price, or a price per zone, in dollars and bolívares', () => {
    expect(deliveryText({ ...base, mode: 'flat', flatPriceCents: 150 }, '888.12')).toContain('$1.50 (1332.18 Bs) to any address')
    const zones = deliveryText({ ...base, zones: [{ name: 'Centro', priceCents: 100 }] }, '888.12')
    expect(zones).toContain('Centro $1.00 (888.12 Bs)')
    expect(zones).toContain('Zones not listed')
  })
})

// «Ajustes → Agente»: how long the agent waits after someone of the company writes is one of a
// closed list (5 minutes to 1 hour), 30 by default; admins only.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
const who = { admin: '', agent: '' }
const settings = { enabled: false, assistantName: 'Vorti', tone: 'friendly', schedule: 'always', businessInfo: '' }

const put = async (body: object, userId = who.admin) => app.inject({ method: 'PUT', url: `/api/tenants/${a.tenantId}/agent`, headers: await bearer(userId), payload: body })
const get = async () => (await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/agent`, headers: await bearer(who.admin) })).json<{ humanPauseMinutes: number }>()

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  who.admin = await seedUser(t.db, 'Juan')
  who.agent = await seedUser(t.db, 'Carla')
  await seedMembership(t.db, a.tenantId, who.admin, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.agent, { role: 'agent' })
  app = await buildTestApp(t.db)
})
afterAll(async () => {
  await app.close()
  await t.close()
})

describe('how long the agent waits after someone of the company writes', () => {
  it('is 30 minutes until the company chooses', async () => {
    expect(await get()).toMatchObject({ humanPauseMinutes: 30 })
    expect((await put(settings)).json()).toMatchObject({ humanPauseMinutes: 30 })
  })

  it('takes only the listed choices, 1 hour at most', async () => {
    expect((await put({ ...settings, humanPauseMinutes: 5 })).json()).toMatchObject({ humanPauseMinutes: 5 })
    expect((await put({ ...settings, humanPauseMinutes: 60 })).json()).toMatchObject({ humanPauseMinutes: 60 })
    expect((await put({ ...settings, humanPauseMinutes: 45 })).json()).toEqual({ error: 'invalid_request' })
    expect((await put({ ...settings, humanPauseMinutes: 120 })).json()).toEqual({ error: 'invalid_request' })
    expect(await get()).toMatchObject({ humanPauseMinutes: 60 })
  })

  it('only admins change it', async () => {
    expect((await put({ ...settings, humanPauseMinutes: 5 }, who.agent)).json()).toEqual({ error: 'admin_required' })
  })
})

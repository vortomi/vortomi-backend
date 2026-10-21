// Who can enter which company, over HTTP. The panel's whole session starts here.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const people = { laura: '', carlos: '', valeria: '', ines: '', yornel: '', stranger: randomUUID() }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  people.laura = await seedUser(t.db, 'Laura')
  people.carlos = await seedUser(t.db, 'Carlos')
  people.valeria = await seedUser(t.db, 'Valeria')
  people.ines = await seedUser(t.db, 'Ines')
  people.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  await seedMembership(t.db, a.tenantId, people.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, people.carlos, { channelAccountIds: [a.channelAccountId] })
  // Valeria works for both companies, with a different role in each.
  await seedMembership(t.db, a.tenantId, people.valeria, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, people.valeria, { role: 'admin' })
  // Ines left company A.
  await seedMembership(t.db, a.tenantId, people.ines, { status: 'disabled' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const get = async (url: string, userId?: string, aal: 'aal1' | 'aal2' = 'aal1') =>
  app.inject({ method: 'GET', url, headers: userId ? await bearer(userId, { aal }) : {} })

describe('signing in', () => {
  it('refuses any request without a token', async () => {
    const response = await get('/api/me')
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'missing_token' })
  })

  it('refuses a malformed authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Basic abc' } })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a real Supabase user who was never invited', async () => {
    const response = await get('/api/me', people.stranger)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'no_account' })
  })

  it('lists only the companies the person is active in', async () => {
    const valeria = (await get('/api/me', people.valeria)).json<{ companies: { name: string; role: string }[] }>()
    expect(valeria.companies[0]).toMatchObject({ slug: 'empresa-a', plan: 'team', timezone: 'America/Caracas', tenantStatus: 'active' })
    expect(valeria.companies.map((c) => [c.name, c.role])).toEqual([
      ['Empresa A', 'agent'],
      ['Empresa B', 'admin'],
    ])
    const ines = (await get('/api/me', people.ines)).json<{ companies: unknown[] }>()
    expect(ines.companies).toEqual([])
  })
})

describe('entering a company', () => {
  it('returns the caller role and numbers in their own company', async () => {
    const response = await get(`/api/tenants/${a.tenantId}/me`, people.carlos)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      tenantId: a.tenantId,
      userId: people.carlos,
      role: 'agent',
      canSeeOthers: false,
      channelAccountIds: [a.channelAccountId],
    })
  })

  it('gives the same person a different role in each company', async () => {
    expect((await get(`/api/tenants/${a.tenantId}/me`, people.valeria)).json()).toMatchObject({ role: 'agent' })
    expect((await get(`/api/tenants/${b.tenantId}/me`, people.valeria)).json()).toMatchObject({ role: 'admin' })
  })

  it.each([
    ['another company', () => b.tenantId, () => people.laura],
    ['an unknown company', () => randomUUID(), () => people.laura],
    ['a malformed id', () => 'abc', () => people.laura],
    ['a company the person left', () => a.tenantId, () => people.ines],
    ['a company, without membership, as super admin', () => a.tenantId, () => people.yornel],
  ])('answers the same 403 for %s', async (_case, tenantId, userId) => {
    const response = await get(`/api/tenants/${tenantId()}/me`, userId())
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'not_a_member' })
  })
})

describe('platform console', () => {
  it('is closed to company members', async () => {
    const response = await get('/api/platform/tenants', people.laura, 'aal2')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'platform_admin_required' })
  })

  it('requires the second factor even for our team', async () => {
    const response = await get('/api/platform/tenants', people.yornel, 'aal1')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'second_factor_required' })
  })

  it('lists the companies, and nothing of their conversations', async () => {
    const response = await get('/api/platform/tenants', people.yornel, 'aal2')
    expect(response.statusCode).toBe(200)
    const { tenants } = response.json<{ tenants: Record<string, unknown>[] }>()
    expect(tenants.map((tenant) => tenant['name'])).toEqual(['Empresa A', 'Empresa B'])
    expect(Object.keys(tenants[0]!).sort()).toEqual(['createdAt', 'id', 'name', 'plan', 'status'])
  })
})

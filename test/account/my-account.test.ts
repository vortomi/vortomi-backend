// «Mi perfil» (mockup web-29): anyone sees and changes only their own account. The name is saved on
// the server, devices are listed with IPs half hidden, one's own other devices can be signed out
// (never the one in use), and our staff sees their own console activity — with the second factor.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformActivity, users } from '../../src/db/schema/index.ts'
import { FakeStaffAccounts, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const HERE = '11111111-1111-4111-8111-111111111111'
const LAPTOP = '22222222-2222-4222-8222-222222222222'
const OTHER_PERSON = '33333333-3333-4333-8333-333333333333'
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const auth = new FakeStaffAccounts()
const who = { boss: '', valeria: '' }

const asUser = async (userId: string, method: 'GET' | 'PUT' | 'DELETE', path: string, payload?: object, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api${path}`, headers: await bearer(userId, { aal, sessionId: HERE }), ...(payload ? { payload } : {}) })

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.boss = await seedUser(t.db, 'Yornel', 'super_admin')
  who.valeria = await seedUser(t.db, 'Valeria')
  await seedMembership(t.db, a.tenantId, who.valeria)
  await seedMembership(t.db, b.tenantId, who.valeria, { role: 'admin' })
  const now = Date.now()
  auth.accountsById.set(who.boss, { lastSignInAt: new Date(now - 60_000), codeSince: new Date('2026-10-29T10:00:00Z'), codeLastUsedAt: new Date(now - 60_000) })
  auth.sessionList = [
    { id: HERE, userId: who.boss, userAgent: CHROME_MAC, ip: '190.75.10.20', createdAt: new Date(now - 3_600_000), lastActiveAt: new Date(now) },
    { id: LAPTOP, userId: who.boss, userAgent: CHROME_MAC, ip: '200.44.1.2', createdAt: new Date(now - 9 * 86_400_000), lastActiveAt: new Date(now - 9 * 86_400_000) },
    { id: OTHER_PERSON, userId: who.valeria, userAgent: CHROME_MAC, ip: '10.1.2.3', createdAt: new Date(now), lastActiveAt: new Date(now) },
  ]
  await t.db.insert(platformActivity).values({ actorUserId: who.boss, action: 'tenant.suspended', tenantId: a.tenantId, tenantName: 'Taller Ortiz' })
  app = await buildTestApp(t.db, { staffAccounts: auth })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('my profile', () => {
  it('a staff member: code, devices (mine only, IPs half hidden, this one marked) and own console activity', async () => {
    const profile = (await asUser(who.boss, 'GET', '/me/profile')).json<{
      staff: boolean
      code: { since: string } | null
      sessions: { id: string; ip: string; current: boolean }[]
      activity: { action: string; target: string }[]
    }>()
    expect(profile).toMatchObject({ staff: true, code: { since: '2026-10-29T10:00:00.000Z' }, activity: [{ action: 'tenant.suspended', target: 'Taller Ortiz' }] })
    expect(profile.sessions.map((s) => [s.id, s.ip, s.current])).toEqual([
      [HERE, '190.75.x.x', true],
      [LAPTOP, '200.44.x.x', false],
    ])
  })

  it('a staff member without the second factor sees nothing here', async () => {
    expect((await asUser(who.boss, 'GET', '/me/profile', undefined, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
  })

  it('a company person: their companies with their role, no console activity', async () => {
    const profile = (await asUser(who.valeria, 'GET', '/me/profile', undefined, 'aal1')).json<{ staff: boolean; companies: { role: string }[]; activity: unknown[] }>()
    expect(profile.staff).toBe(false)
    expect(profile.companies.map((c) => c.role).sort()).toEqual(['admin', 'agent'])
    expect(profile.activity).toEqual([])
  })
})

describe('changing my account', () => {
  it('the name is saved on the server, trimmed; an empty one is refused', async () => {
    expect((await asUser(who.valeria, 'PUT', '/me/name', { name: '  Valeria Gil ' }, 'aal1')).json()).toEqual({ name: 'Valeria Gil' })
    expect((await t.db.select({ name: users.name }).from(users).where(eq(users.id, who.valeria)))[0]!.name).toBe('Valeria Gil')
    expect((await asUser(who.valeria, 'PUT', '/me/name', { name: '   ' }, 'aal1')).statusCode).toBe(400)
  })

  it('signs out one of my other devices, never the one in use nor someone else\'s', async () => {
    expect((await asUser(who.boss, 'DELETE', `/me/sessions/${HERE}`)).json()).toEqual({ error: 'not_on_yourself' })
    expect((await asUser(who.boss, 'DELETE', `/me/sessions/${OTHER_PERSON}`)).json()).toEqual({ error: 'session_not_found' })
    expect((await asUser(who.boss, 'DELETE', `/me/sessions/${LAPTOP}`)).statusCode).toBe(204)
  })

  it('«close the others» keeps the one in use', async () => {
    auth.sessionList.push({ id: LAPTOP, userId: who.boss, userAgent: CHROME_MAC, ip: null, createdAt: new Date(), lastActiveAt: new Date() })
    expect((await asUser(who.boss, 'DELETE', '/me/sessions')).json()).toEqual({ ended: 1 })
    expect(auth.sessionList.filter((s) => s.userId === who.boss).map((s) => s.id)).toEqual([HERE])
  })
})

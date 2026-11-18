// Staff (mockup web-28): the console page of our own people shows how safely each one enters (code,
// last access, devices, with IPs half hidden), lets one sign another out of a device or of all of
// them, and keeps «Actividad en la consola»: who changed what in which company, never what was typed.
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformActivity } from '../../src/db/schema/index.ts'
import { maskIp, systemOf } from '../../src/modules/platform/staff-accounts.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { FakeAuthenticatorFactors, FakeStaffAccounts, buildTestApp } from '../helpers/app.ts'
import { bearer, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { seedTwoTenants } from '../helpers/tenants.ts'

const MY_SESSION = '11111111-1111-4111-8111-111111111111'
const LUIS_LAPTOP = '22222222-2222-4222-8222-222222222222'
const LUIS_PHONE = '33333333-3333-4333-8333-333333333333'
const MY_OLD = '44444444-4444-4444-8444-444444444444'
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

let t: TestDatabase
let app: FastifyInstance
const staff = new FakeStaffAccounts()
const who = { me: '', luis: '' }
let tenantA = ''

const asMe = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, userId = who.me) =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal: 'aal2', sessionId: MY_SESSION }), ...(payload ? { payload } : {}) })

interface Team {
  admins: { userId: string; lastSignInAt: string | null; codeSince: string | null; sessionCount: number; lastActionAt: string | null }[]
  sessions: { id: string; browser: string; system: string; mobile: boolean; ip: string | null; current: boolean }[]
  events: { action: string; subjectName: string | null }[]
  activity: { action: string; actorName: string; tenantName: string | null }[]
}
const team = async () => {
  const response = await asMe('GET', '/team')
  if (response.statusCode !== 200) throw new Error(`GET /team answered ${response.statusCode}: ${response.body}`)
  return response.json<Team>()
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a: { tenantId: tenantA } } = await seedTwoTenants(t.db))
  who.me = await seedUser(t.db, 'Yornel', 'super_admin')
  who.luis = await seedUser(t.db, 'Luis', 'super_admin')
  const now = Date.now()
  staff.accountsById.set(who.luis, { lastSignInAt: new Date(now - 12 * 60_000), codeSince: new Date('2026-11-17T10:00:00Z'), codeLastUsedAt: new Date(now - 60_000) })
  staff.sessionList = [
    { id: MY_SESSION, userId: who.me, userAgent: CHROME_WINDOWS, ip: '190.75.10.20', createdAt: new Date(now - 3_600_000), lastActiveAt: new Date(now) },
    { id: MY_OLD, userId: who.me, userAgent: CHROME_WINDOWS, ip: '200.44.1.2', createdAt: new Date(now - 9 * 86_400_000), lastActiveAt: new Date(now - 9 * 86_400_000) },
    { id: LUIS_LAPTOP, userId: who.luis, userAgent: CHROME_WINDOWS, ip: '190.205.33.44', createdAt: new Date(now - 86_400_000), lastActiveAt: new Date(now - 12 * 60_000) },
    { id: LUIS_PHONE, userId: who.luis, userAgent: SAFARI_IPHONE, ip: '2800:e2:5a00::1', createdAt: new Date(now - 86_400_000), lastActiveAt: new Date(now - 86_400_000) },
  ]
  app = await buildTestApp(t.db, { authenticatorFactors: new FakeAuthenticatorFactors(), staffAccounts: staff })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('how safely each one enters', () => {
  it('last access, code dates and open devices; IPs half hidden; my current session marked', async () => {
    const page = await team()
    expect(page.admins.find((a) => a.userId === who.luis)).toMatchObject({ sessionCount: 2, codeSince: '2026-11-17T10:00:00.000Z' })
    expect(page.admins.find((a) => a.userId === who.me)).toMatchObject({ sessionCount: 2, lastSignInAt: null })
    expect(page.sessions.find((s) => s.id === LUIS_PHONE)).toMatchObject({ browser: 'Safari', system: 'iPhone', mobile: true, ip: '2800:e2::…' })
    expect(page.sessions.find((s) => s.id === LUIS_LAPTOP)).toMatchObject({ browser: 'Chrome', system: 'Windows', ip: '190.205.x.x', current: false })
    expect(page.sessions.find((s) => s.id === MY_SESSION)?.current).toBe(true)
    expect(JSON.stringify(page)).not.toContain('190.205.33.44')
  })

  it('reads devices people recognise, and never shows a whole address', () => {
    expect(systemOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toEqual({ name: 'macOS', mobile: false })
    expect(maskIp('10.0.0')).toBeNull()
    expect(maskIp(null)).toBeNull()
  })
})

describe('signing someone out', () => {
  it('one device of another person; never my current one; my other ones yes', async () => {
    expect((await asMe('DELETE', `/team/admins/${who.luis}/sessions/${LUIS_PHONE}`)).statusCode).toBe(204)
    expect((await asMe('DELETE', `/team/admins/${who.me}/sessions/${MY_SESSION}`)).json()).toEqual({ error: 'not_on_yourself' })
    expect((await asMe('DELETE', `/team/admins/${who.me}/sessions/${MY_OLD}`)).statusCode).toBe(204)
    // A session that is not that person's (or already ended) is not found.
    expect((await asMe('DELETE', `/team/admins/${who.luis}/sessions/${MY_OLD}`)).json()).toEqual({ error: 'session_not_found' })
  })

  it('every device of another person, never all of mine; it stays in the history', async () => {
    expect((await asMe('DELETE', `/team/admins/${who.luis}/sessions`)).json()).toEqual({ ended: 1 })
    expect((await asMe('DELETE', `/team/admins/${who.me}/sessions`)).json()).toEqual({ error: 'not_on_yourself' })
    const page = await team()
    expect(page.sessions.map((s) => s.id)).toEqual([MY_SESSION])
    expect(page.events.slice(0, 3).map((e) => [e.action, e.subjectName])).toEqual([
      ['admin.sessions_ended', 'Luis'],
      ['admin.session_ended', 'Yornel'],
      ['admin.session_ended', 'Luis'],
    ])
  })
})

describe('«Actividad en la consola»', () => {
  it('records who changed what in which company, only when the change succeeded', async () => {
    const created = (await asMe('POST', '/tenants', { name: 'Panadería Nueva', businessType: 'food', city: 'Valencia', timezone: 'America/Caracas', plan: 'basic', legalName: 'Panadería Nueva, C.A.', taxId: 'J-12345678-9', fiscalAddress: 'Av. Bolívar' })).json<{ id: string }>()
    expect((await asMe('PUT', `/tenants/${tenantA}/status`, { status: 'suspended' })).statusCode).toBe(204)
    expect((await asMe('PUT', `/tenants/${tenantA}/status`, { status: 'active' })).statusCode).toBe(204)
    // A refused change (bad input) records nothing.
    expect((await asMe('PUT', `/tenants/${tenantA}/status`, { status: 'whatever' })).statusCode).toBe(400)
    expect((await asMe('DELETE', `/tenants/${created.id}`)).statusCode).toBe(204)
    const page = await team()
    expect(page.activity.map((a) => [a.action, a.actorName, a.tenantName])).toEqual([
      ['tenant.draft_discarded', 'Yornel', 'Panadería Nueva'],
      ['tenant.activated', 'Yornel', expect.any(String)],
      ['tenant.suspended', 'Yornel', expect.any(String)],
      ['tenant.created', 'Yornel', 'Panadería Nueva'],
    ])
    expect(page.admins.find((a) => a.userId === who.me)?.lastActionAt).not.toBeNull()
  })

  it('reading (lists, figures, Meta lookups) records nothing', async () => {
    const before = (await team()).activity.length
    await asMe('GET', '/tenants')
    await asMe('GET', `/tenants/${tenantA}`)
    expect((await team()).activity).toHaveLength(before)
  })

  it('nobody rewrites it, and no company can read it', async () => {
    await expect(t.db.update(platformActivity).set({ tenantName: 'otra' })).rejects.toThrow()
    await expect(t.db.execute(sql`delete from platform_activity`)).rejects.toThrow()
    expect(await dbError(withTenant(t.db, tenantA, ({ tx }) => tx.select().from(platformActivity)))).toMatch(/permission denied/)
  })
})

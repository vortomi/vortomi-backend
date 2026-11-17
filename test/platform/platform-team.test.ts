// Our console's own team (mockup web-22): an admin invites another, the invited person joins with
// their own account and sets up their own authenticator code; codes are reset and access removed
// from the console, never on oneself, and every step stays in an append-only history.
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformTeamEvents, users } from '../../src/db/schema/index.ts'
import { FakeAuthenticatorFactors, buildTestApp } from '../helpers/app.ts'
import { bearer, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'

let t: TestDatabase
let app: FastifyInstance
const factors = new FakeAuthenticatorFactors()
const who = { boss: '', ana: '', laura: '' }
const ANA = 'ana@example.com'
let anaToken = ''

const console_ = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object, userId = who.boss, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal }), ...(payload ? { payload } : {}) })
const roleOf = async (userId: string) => (await t.db.select({ role: users.platformRole }).from(users).where(eq(users.id, userId)))[0]!.role

beforeAll(async () => {
  t = await createTestDatabase()
  who.boss = await seedUser(t.db, 'Jefe', 'super_admin')
  who.ana = await seedUser(t.db, 'Ana')
  who.laura = await seedUser(t.db, 'Laura')
  factors.withCodes.add(who.boss)
  app = await buildTestApp(t.db, { authenticatorFactors: factors })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('who sees and changes the console team', () => {
  it('only an admin of the console, with the second factor', async () => {
    expect((await console_('GET', '/team', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('GET', '/team', undefined, who.boss, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
  })

  it('lists the admins, whether each set up their code, and which one is me', async () => {
    const team = (await console_('GET', '/team')).json<{ admins: { userId: string; hasCode: boolean; isYou: boolean }[] }>()
    expect(team.admins).toEqual([expect.objectContaining({ userId: who.boss, hasCode: true, isYou: true })])
  })
})

describe('inviting another admin', () => {
  it('gives a one-time link; one open invitation per person, never for someone already in', async () => {
    const invited = await console_('POST', '/team/invitations', { name: 'Ana Medina', email: 'ANA@example.com' })
    expect(invited.statusCode).toBe(201)
    const body = invited.json<{ token: string; email: string }>()
    expect(body.email).toBe(ANA)
    anaToken = body.token
    expect((await console_('POST', '/team/invitations', { name: 'Ana', email: ANA })).json()).toEqual({ error: 'invitation_exists' })
    expect((await console_('POST', '/team/invitations', { name: 'Jefe', email: 'jefe@example.com' })).json()).toEqual({ error: 'already_platform_admin' })
  })

  it('the link shows who it is for, without a session', async () => {
    const preview = await app.inject({ method: 'GET', url: `/api/public/platform-invitations/${anaToken}` })
    expect(preview.json()).toMatchObject({ email: ANA, name: 'Ana Medina', hasAccount: true })
  })

  it('only the invited email accepts it, once; then the person is an admin', async () => {
    const accept = async (userId: string, email: string) =>
      app.inject({ method: 'POST', url: `/api/platform-invitations/${anaToken}/accept`, headers: await bearer(userId, { email }), payload: {} })
    expect((await accept(who.laura, 'laura@example.com')).json()).toEqual({ error: 'invitation_email_mismatch' })
    expect((await accept(who.ana, ANA)).json()).toEqual({ platform: true })
    expect(await roleOf(who.ana)).toBe('super_admin')
    expect((await accept(who.ana, ANA)).json()).toEqual({ error: 'invitation_not_found' })
  })

  it('the new admin still needs their own second factor to open the console', async () => {
    expect((await console_('GET', '/team', undefined, who.ana, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
    expect((await console_('GET', '/team', undefined, who.ana)).statusCode).toBe(200)
  })

  it('a pending invitation can get a new link or be cancelled', async () => {
    const pending = (await console_('POST', '/team/invitations', { name: 'Laura', email: 'laura@example.com' })).json<{ id: string; token: string }>()
    const renewed = (await console_('POST', `/team/invitations/${pending.id}/renew`)).json<{ token: string }>()
    expect(renewed.token).not.toBe(pending.token)
    expect((await app.inject({ method: 'GET', url: `/api/public/platform-invitations/${pending.token}` })).json()).toEqual({ error: 'invitation_not_found' })
    expect((await console_('DELETE', `/team/invitations/${pending.id}`)).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/public/platform-invitations/${renewed.token}` })).json()).toEqual({ error: 'invitation_not_found' })
  })
})

describe('a lost phone, and someone who leaves', () => {
  it('resets another admin\'s code, never one\'s own', async () => {
    expect((await console_('POST', `/team/admins/${who.ana}/reset-code`)).statusCode).toBe(204)
    expect(factors.resets).toEqual([who.ana])
    expect((await console_('POST', `/team/admins/${who.boss}/reset-code`)).json()).toEqual({ error: 'not_on_yourself' })
  })

  it('removes another admin at once, never oneself', async () => {
    expect((await console_('DELETE', `/team/admins/${who.ana}`, undefined, who.ana)).json()).toEqual({ error: 'not_on_yourself' })
    expect((await console_('DELETE', `/team/admins/${who.ana}`)).statusCode).toBe(204)
    expect(await roleOf(who.ana)).toBeNull()
    expect((await console_('GET', '/team', undefined, who.ana)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('DELETE', `/team/admins/${who.ana}`)).json()).toEqual({ error: 'platform_admin_not_found' })
  })

  it('every step stays in a history nobody can rewrite', async () => {
    const team = (await console_('GET', '/team')).json<{ events: { action: string }[] }>()
    expect(team.events.map((e) => e.action)).toEqual([
      'admin.removed',
      'admin.code_reset',
      'admin.invitation_revoked',
      'admin.invitation_renewed',
      'admin.invited',
      'admin.joined',
      'admin.invited',
    ])
    await expect(t.db.update(platformTeamEvents).set({ subjectEmail: 'x@example.com' })).rejects.toThrow()
    await expect(t.db.execute(sql`delete from platform_team_events`)).rejects.toThrow()
  })
})

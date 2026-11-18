// Passwords without email (mockup web-30): a one-time link, 24 hours, that the owner gives their
// staff, the console gives anyone and the staff give each other. The person chooses the password;
// nobody else ever sees it. Giving a link already locks the old password and signs them out.
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { invitations, memberships, passwordResets, platformActivity, platformTeamEvents, users } from '../../src/db/schema/index.ts'
import { InvitationService } from '../../src/modules/team/invitation-service.ts'
import { hashOf } from '../../src/modules/team/invitation-token.ts'
import { FakeAccountPasswords, FakeStaffAccounts, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const passwords = new FakeAccountPasswords()
const auth = new FakeStaffAccounts()
const who = { laura: '', carlos: '', ana: '', valeria: '', yornel: '', luis: '' }

type Method = 'GET' | 'POST' | 'PUT'
const call = async (userId: string, method: Method, path: string, payload?: object) =>
  app.inject({ method, url: `/api${path}`, headers: await bearer(userId, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
const open = (method: 'GET' | 'POST', token: string, payload?: object) =>
  app.inject({ method, url: `/api/public/password-resets/${token}`, ...(payload ? { payload } : {}) })
const company = (path = '') => `/tenants/${a.tenantId}${path}`

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.ana = await seedUser(t.db, 'Ana')
  who.valeria = await seedUser(t.db, 'Valeria')
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.luis = await seedUser(t.db, 'Luis', 'super_admin')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', isOwner: true })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, a.tenantId, who.ana, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.valeria)
  await seedMembership(t.db, b.tenantId, who.valeria, { role: 'admin', isOwner: true })
  await seedMembership(t.db, a.tenantId, who.yornel, { role: 'admin' })
  app = await buildTestApp(t.db, { accountPasswords: passwords, staffAccounts: auth })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

beforeEach(() => {
  auth.sessionList = [{ id: crypto.randomUUID(), userId: who.carlos, userAgent: null, ip: null, createdAt: new Date(), lastActiveAt: new Date() }]
})

describe('the owner gives a link', () => {
  it('to someone only in this company: the old password stops working and their sessions end', async () => {
    const before = passwords.changes
    const answer = await call(who.laura, 'POST', company(`/team/${who.carlos}/password-reset`))
    expect(answer.statusCode).toBe(201)
    const issued = answer.json<{ token: string; name: string; expiresAt: string }>()
    expect(issued.name).toBe('Carlos')
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000)
    expect(passwords.changes).toBe(before + 1)
    expect(auth.sessionList.filter((s) => s.userId === who.carlos)).toEqual([])
    // Only the hash is kept.
    const [row] = await t.db.select().from(passwordResets).where(eq(passwordResets.tokenHash, hashOf(issued.token)))
    expect(row).toMatchObject({ userId: who.carlos, createdBy: who.laura, tenantId: a.tenantId })
  })

  it('the page says who gave it; the person chooses a password once, and is told their email to enter', async () => {
    const { token } = (await call(who.laura, 'POST', company(`/team/${who.carlos}/password-reset`))).json<{ token: string }>()
    expect((await open('GET', token)).json()).toMatchObject({ name: 'Carlos', givenBy: 'Laura', companyName: 'Empresa A', staff: false })

    expect((await open('POST', token, { password: 'corta1' })).statusCode).toBe(400)
    expect((await open('POST', token, { password: 'sinnumeros' })).statusCode).toBe(400)
    expect((await open('POST', token, { password: 'pan2026dulce' })).json()).toEqual({ email: 'carlos@example.com' })
    expect(passwords.passwordOf.get(who.carlos)).toBe('pan2026dulce')

    expect((await open('POST', token, { password: 'otra2026clave' })).json()).toMatchObject({ error: 'reset_not_found' })
    expect((await open('GET', token)).statusCode).toBe(404)
  })

  it('a newer link replaces the older one; a link past its day does not work', async () => {
    const first = (await call(who.laura, 'POST', company(`/team/${who.carlos}/password-reset`))).json<{ token: string }>()
    const second = (await call(who.laura, 'POST', company(`/team/${who.carlos}/password-reset`))).json<{ token: string }>()
    expect((await open('GET', first.token)).statusCode).toBe(404)
    await t.db.update(passwordResets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordResets.tokenHash, hashOf(second.token)))
    expect((await open('POST', second.token, { password: 'pan2026dulce' })).json()).toMatchObject({ error: 'reset_expired' })
  })

  it('never to someone also in another company, to our staff or to oneself', async () => {
    expect((await call(who.laura, 'POST', company(`/team/${who.valeria}/password-reset`))).json()).toMatchObject({ error: 'member_elsewhere' })
    expect((await call(who.laura, 'POST', company(`/team/${who.yornel}/password-reset`))).json()).toMatchObject({ error: 'staff_member' })
    expect((await call(who.laura, 'POST', company(`/team/${who.laura}/password-reset`))).json()).toMatchObject({ error: 'not_on_yourself' })
  })

  it('other admins cannot; agents do not even see the team access', async () => {
    expect((await call(who.ana, 'POST', company(`/team/${who.carlos}/password-reset`))).json()).toMatchObject({ error: 'owner_required' })
    expect((await call(who.carlos, 'GET', company('/team/access'))).json()).toMatchObject({ error: 'admin_required' })
  })

  it('the team access: owner, last access, who can get a link and why not, and the history', async () => {
    auth.accountsById.set(who.carlos, { lastSignInAt: new Date('2026-11-18T10:00:00Z'), codeSince: null, codeLastUsedAt: null })
    const access = (await call(who.laura, 'GET', company('/team/access'))).json<{
      youAreOwner: boolean
      available: boolean
      people: { userId: string; isOwner: boolean; lastSignInAt: string | null; elsewhere: boolean; blocked: string | null }[]
      history: { kind: string; actor: string | null; subject: string }[]
    }>()
    expect(access).toMatchObject({ youAreOwner: true, available: true })
    const of = (id: string) => access.people.find((p) => p.userId === id)
    expect(of(who.laura)).toMatchObject({ isOwner: true, blocked: 'self' })
    expect(of(who.carlos)).toMatchObject({ isOwner: false, blocked: null, elsewhere: false, lastSignInAt: '2026-11-18T10:00:00.000Z' })
    expect(of(who.valeria)).toMatchObject({ elsewhere: true, blocked: 'elsewhere' })
    expect(of(who.yornel)).toMatchObject({ blocked: 'staff' })
    expect(access.history[0]).toMatchObject({ kind: 'reset_given', actor: 'Laura', subject: 'Carlos' })
    expect(access.history.some((e) => e.kind === 'reset_used' && e.actor === 'Carlos')).toBe(true)

    expect((await call(who.ana, 'GET', company('/team/access'))).json()).toMatchObject({ youAreOwner: false })
  })
})

describe('the owner is protected', () => {
  it('another admin can neither demote nor disable them', async () => {
    const demote = await call(who.ana, 'PUT', company(`/team/${who.laura}`), { role: 'agent', canSeeOthers: false, channelAccountIds: [] })
    expect(demote.json()).toMatchObject({ error: 'owner_protected' })
    expect((await call(who.ana, 'PUT', company(`/team/${who.laura}/status`), { status: 'disabled' })).json()).toMatchObject({ error: 'owner_protected' })
  })

  it('the company database refuses to make someone owner from a company request', async () => {
    const { withTenant } = await import('../../src/modules/tenancy/tenant-scope.ts')
    const takeOver = withTenant(t.db, a.tenantId, ({ tx }) => tx.update(memberships).set({ isOwner: true }).where(eq(memberships.userId, who.ana)))
    await expect(takeOver).rejects.toThrow()
    const [me] = await t.db.select({ isOwner: memberships.isOwner }).from(memberships).where(and(eq(memberships.tenantId, a.tenantId), eq(memberships.userId, who.ana)))
    expect(me?.isOwner).toBe(false)
  })

  it('the first admin to accept an invitation to a company without owner becomes it', async () => {
    const service = new InvitationService(t.db)
    await t.db.update(memberships).set({ isOwner: false }).where(eq(memberships.tenantId, b.tenantId))
    const newcomer = await seedUser(t.db, 'Pedro')
    const { token } = await service.createIn(t.db, b.tenantId, { email: 'pedro@example.com', name: 'Pedro', role: 'admin', canSeeOthers: true, channelAccountIds: [] }, who.valeria)
    await service.accept({ userId: newcomer, email: 'pedro@example.com', secondFactor: false }, token)
    const owners = await t.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, b.tenantId), eq(memberships.isOwner, true)))
    expect(owners).toEqual([{ userId: newcomer }])
    await t.db.delete(invitations).where(eq(invitations.tenantId, b.tenantId))
  })
})

describe('the console', () => {
  it('gives a link to anyone of a company, owners included; recorded as console activity, given by «Vortomi»', async () => {
    const answer = await call(who.luis, 'POST', `/platform/tenants/${a.tenantId}/members/${who.laura}/password-reset`)
    expect(answer.statusCode).toBe(201)
    expect((await open('GET', answer.json<{ token: string }>().token)).json()).toMatchObject({ name: 'Laura', givenBy: null, companyName: 'Empresa A' })
    const [activity] = await t.db.select().from(platformActivity).where(eq(platformActivity.action, 'tenant.password_reset'))
    expect(activity).toMatchObject({ actorUserId: who.luis, tenantId: a.tenantId, tenantName: 'Empresa A' })
  })

  it('shows each person\'s other companies and hands the company to another active admin', async () => {
    const detail = (await call(who.luis, 'GET', `/platform/tenants/${a.tenantId}`)).json<{ members: { userId: string; isOwner: boolean; otherCompanies: string[] }[] }>()
    expect(detail.members.find((m) => m.userId === who.valeria)?.otherCompanies).toEqual(['Empresa B'])
    expect(detail.members.find((m) => m.userId === who.laura)?.isOwner).toBe(true)

    expect((await call(who.luis, 'PUT', `/platform/tenants/${a.tenantId}/owner`, { userId: who.carlos })).json()).toMatchObject({ error: 'owner_not_admin' })
    expect((await call(who.luis, 'PUT', `/platform/tenants/${a.tenantId}/owner`, { userId: who.ana })).statusCode).toBe(204)
    const owners = await t.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.tenantId, a.tenantId), eq(memberships.isOwner, true)))
    expect(owners).toEqual([{ userId: who.ana }])
    expect((await t.db.select().from(platformActivity).where(eq(platformActivity.action, 'tenant.owner_changed'))).length).toBe(1)
    await call(who.luis, 'PUT', `/platform/tenants/${a.tenantId}/owner`, { userId: who.laura })
  })

  it('the staff give each other links, never to themselves', async () => {
    const answer = await call(who.luis, 'POST', `/platform/team/admins/${who.yornel}/password-reset`)
    expect(answer.statusCode).toBe(201)
    expect((await open('GET', answer.json<{ token: string }>().token)).json()).toMatchObject({ name: 'Yornel', givenBy: 'Luis', companyName: null, staff: true })
    expect((await call(who.luis, 'POST', `/platform/team/admins/${who.luis}/password-reset`)).json()).toMatchObject({ error: 'not_on_yourself' })
    const [event] = await t.db.select().from(platformTeamEvents).where(eq(platformTeamEvents.action, 'admin.password_reset'))
    expect(event).toMatchObject({ actorUserId: who.luis, subjectEmail: 'yornel@example.com' })
  })
})

describe('without the Supabase secret key', () => {
  it('nobody can give a link: the panel says it is not available', async () => {
    const bare = await buildTestApp(t.db, { accountPasswords: null })
    const answer = await bare.inject({ method: 'POST', url: `/api${company(`/team/${who.carlos}/password-reset`)}`, headers: await bearer(who.laura) })
    expect(answer.json()).toMatchObject({ error: 'reset_unavailable' })
    await bare.close()
  })
})

describe('the link table is server-only', () => {
  it('a company scope cannot read it', async () => {
    const { withTenant } = await import('../../src/modules/tenancy/tenant-scope.ts')
    const attempt = withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(passwordResets))
    await expect(attempt).rejects.toThrow()
    expect((await t.db.select({ id: users.id }).from(users)).length).toBeGreaterThan(0)
  })
})

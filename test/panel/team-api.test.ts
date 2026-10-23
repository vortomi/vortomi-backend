// The company's admins manage their people: invite with a one-time link, change role and
// numbers, disable and bring back. A company is never left without an admin, and nothing
// here reaches another company.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invitations } from '../../src/db/schema/index.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '' }

interface Member {
  userId: string
  name: string
  role: string
  status: string
  canSeeOthers: boolean
  channelAccountIds: string[]
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const call = async (userId: string, method: Method, path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const team = async (query = '') => (await call(who.laura, 'GET', `/team${query}`)).json<{ items: Member[] }>().items
const member = async (userId: string) => (await team('?include=disabled')).find((m) => m.userId === userId)!

describe('inviting', () => {
  const invite = { email: 'Sofia@Example.com', name: 'Sofía', role: 'agent', channelAccountIds: [] as string[] }
  let token = ''

  it('admins invite; the link token comes back once and only its hash is stored', async () => {
    expect((await call(who.carlos, 'POST', '/team/invitations', invite)).json()).toEqual({ error: 'admin_required' })
    const created = await call(who.laura, 'POST', '/team/invitations', { ...invite, channelAccountIds: [a.channelAccountId] })
    expect(created.statusCode).toBe(201)
    const body = created.json<{ email: string; token: string }>()
    expect(body.email).toBe('sofia@example.com')
    token = body.token
    const [stored] = await t.db.select().from(invitations).where(eq(invitations.email, 'sofia@example.com'))
    expect(stored!.tokenHash).not.toBe(token)
    expect((await call(who.laura, 'POST', '/team/invitations', invite)).json()).toEqual({ error: 'invitation_exists' })
  })

  it('refuses numbers of another company and people already in the team', async () => {
    const foreign = { ...invite, email: 'otro@example.com', channelAccountIds: [b.channelAccountId] }
    expect((await call(who.laura, 'POST', '/team/invitations', foreign)).json()).toEqual({ error: 'unknown_channel' })
    expect((await call(who.laura, 'POST', '/team/invitations', { ...invite, email: 'carlos@example.com' })).json()).toEqual({ error: 'already_member' })
  })

  it('anyone with the link sees who it is for, without a session; a made-up link shows nothing', async () => {
    const preview = await app.inject({ method: 'GET', url: `/api/public/invitations/${token}` })
    expect(preview.json()).toMatchObject({ email: 'sofia@example.com', name: 'Sofía', role: 'agent', hasAccount: false })
    const fake = await app.inject({ method: 'GET', url: `/api/public/invitations/${'x'.repeat(43)}` })
    expect(fake.json()).toEqual({ error: 'invitation_not_found' })
  })

  it('only the invited email can accept, once; then the person is in, with the numbers chosen', async () => {
    const sofia = randomUUID()
    const bearerAccept = async (userId: string, email: string) =>
      app.inject({ method: 'POST', url: `/api/invitations/${token}/accept`, headers: await bearer(userId, { email }), payload: { name: 'Sofía Pérez' } })
    expect((await bearerAccept(randomUUID(), 'intruso@example.com')).json()).toEqual({ error: 'invitation_email_mismatch' })
    expect((await bearerAccept(sofia, 'sofia@example.com')).json()).toEqual({ tenantId: a.tenantId })
    expect((await bearerAccept(sofia, 'sofia@example.com')).json()).toEqual({ error: 'invitation_not_found' })
    expect(await member(sofia)).toMatchObject({ name: 'Sofía Pérez', role: 'agent', status: 'active', channelAccountIds: [a.channelAccountId] })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: await bearer(sofia, { email: 'sofia@example.com' }) })
    expect(me.json<{ companies: { tenantId: string }[] }>().companies.map((c) => c.tenantId)).toEqual([a.tenantId])
  })

  it('renewing gives a new link and kills the old one; revoking kills it for good', async () => {
    const created = (await call(who.laura, 'POST', '/team/invitations', { ...invite, email: 'ana@example.com' })).json<{ id: string; token: string }>()
    const renewed = (await call(who.laura, 'POST', `/team/invitations/${created.id}/renew`)).json<{ token: string }>()
    expect(renewed.token).not.toBe(created.token)
    expect((await app.inject({ method: 'GET', url: `/api/public/invitations/${created.token}` })).json()).toEqual({ error: 'invitation_not_found' })
    expect((await call(who.laura, 'DELETE', `/team/invitations/${created.id}`)).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/public/invitations/${renewed.token}` })).json()).toEqual({ error: 'invitation_not_found' })
    expect((await call(who.laura, 'GET', '/team/invitations')).json<{ items: unknown[] }>().items).toEqual([])
  })

  it('an expired link is refused', async () => {
    const created = (await call(who.laura, 'POST', '/team/invitations', { ...invite, email: 'tarde@example.com' })).json<{ id: string; token: string }>()
    await t.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, created.id))
    expect((await app.inject({ method: 'GET', url: `/api/public/invitations/${created.token}` })).json()).toEqual({ error: 'invitation_expired' })
  })

  it('another company cannot see, renew or revoke these invitations', async () => {
    const [open] = (await call(who.laura, 'GET', '/team/invitations')).json<{ items: { id: string }[] }>().items
    expect((await call(who.pedro, 'GET', '/team/invitations', undefined, b.tenantId)).json<{ items: unknown[] }>().items).toEqual([])
    expect((await call(who.pedro, 'POST', `/team/invitations/${open!.id}/renew`, undefined, b.tenantId)).json()).toEqual({ error: 'invitation_not_found' })
  })
})

describe('changing people', () => {
  it('admins change role, numbers and who sees others; admins always see everything', async () => {
    const change = { role: 'agent', canSeeOthers: true, channelAccountIds: [] }
    expect((await call(who.carlos, 'PUT', `/team/${who.carlos}`, change)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', `/team/${who.carlos}`, change)).statusCode).toBe(204)
    expect(await member(who.carlos)).toMatchObject({ canSeeOthers: true, channelAccountIds: [] })
    expect((await call(who.laura, 'PUT', `/team/${who.carlos}`, { role: 'admin', canSeeOthers: false, channelAccountIds: [] })).statusCode).toBe(204)
    expect(await member(who.carlos)).toMatchObject({ role: 'admin', canSeeOthers: true })
  })

  it('a number of another company is refused', async () => {
    const change = { role: 'agent', canSeeOthers: false, channelAccountIds: [b.channelAccountId] }
    expect((await call(who.laura, 'PUT', `/team/${who.carlos}`, change)).json()).toEqual({ error: 'unknown_channel' })
  })

  it('the last active admin can be neither demoted nor disabled; nobody disables themselves', async () => {
    expect((await call(who.laura, 'PUT', `/team/${who.laura}/status`, { status: 'disabled' })).json()).toEqual({ error: 'cannot_disable_self' })
    expect((await call(who.laura, 'PUT', `/team/${who.carlos}/status`, { status: 'disabled' })).statusCode).toBe(204)
    const demote = { role: 'agent', canSeeOthers: false, channelAccountIds: [] }
    expect((await call(who.laura, 'PUT', `/team/${who.laura}`, demote)).json()).toEqual({ error: 'last_admin' })
  })

  it('a disabled person is out of the team list and of the company, and comes back with the same access', async () => {
    expect((await team()).map((m) => m.userId)).not.toContain(who.carlos)
    expect((await call(who.carlos, 'GET', '/team')).json()).toEqual({ error: 'not_a_member' })
    expect((await call(who.laura, 'PUT', `/team/${who.carlos}/status`, { status: 'active' })).statusCode).toBe(204)
    expect(await member(who.carlos)).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('another company cannot touch these people', async () => {
    const change = { role: 'agent', canSeeOthers: false, channelAccountIds: [] }
    expect((await call(who.pedro, 'PUT', `/team/${who.carlos}`, change, b.tenantId)).json()).toEqual({ error: 'member_not_found' })
  })
})

describe('numbers', () => {
  it('admins rename a number; agents cannot', async () => {
    expect((await call(who.laura, 'PUT', `/channels/${a.channelAccountId}`, { label: 'Ventas Valencia' })).json()).toMatchObject({ label: 'Ventas Valencia' })
    const agent = await seedUser(t.db, 'Agente Nuevo')
    await seedMembership(t.db, a.tenantId, agent, { channelAccountIds: [a.channelAccountId] })
    expect((await call(agent, 'PUT', `/channels/${a.channelAccountId}`, { label: 'X' })).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.pedro, 'PUT', `/channels/${a.channelAccountId}`, { label: 'X' }, b.tenantId)).json()).toEqual({ error: 'channel_not_found' })
  })
})

// The platform console signs up a company end to end: create it, connect its number with
// the token encrypted, see the first customer message arrive (when, never what), invite
// its admin, go live, suspend. Only super admins with the second factor reach any of it.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { channelAccounts, channelCredentials, conversations } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { ChannelDirectory } from '../../src/modules/tenancy/channel-directory.ts'
import { FakeWabaDirectory, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let other: SeededTenant
const waba = new FakeWabaDirectory()
const who = { yornel: '', laura: '' }
let tenantId = ''
let channelId = ''

const company = {
  name: 'Panadería Corteza',
  businessType: 'food',
  city: 'Valencia',
  plan: 'basic',
  legalName: 'Corteza, C.A.',
  taxId: 'j 41.234.567 8',
  fiscalAddress: 'Av. Bolívar, Valencia',
}
const TOKEN = 'EAAG-test-token-of-the-company-0123456789'

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ b: other } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, other.tenantId, who.laura, { role: 'admin' })
  waba.accounts.set('300000000000001', [
    { phoneNumberId: '400000000000001', displayNumber: '+58 241-555-0101', verifiedName: 'Corteza', nameStatus: 'APPROVED' },
    { phoneNumberId: other.phoneNumberId, displayNumber: '+58 412-555-0199', verifiedName: 'Ajeno', nameStatus: 'APPROVED' },
  ])
  app = await buildTestApp(t.db, { wabaDirectory: waba })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const console_ = async (method: Method, path: string, payload?: object, userId = who.yornel, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal }), ...(payload ? { payload } : {}) })

describe('who reaches the console', () => {
  it('only a super admin, and only with the second factor', async () => {
    expect((await console_('POST', '/tenants', company, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('POST', '/tenants', company, who.yornel, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
  })
})

describe('signing up a company', () => {
  it('creates it as a draft with its RIF normalised and a free slug', async () => {
    const created = await console_('POST', '/tenants', company)
    expect(created.statusCode).toBe(201)
    const body = created.json<{ id: string; status: string; taxId: string; slug: string }>()
    tenantId = body.id
    expect(body).toMatchObject({ status: 'draft', taxId: 'J-41234567-8', slug: 'panaderia-corteza' })
    expect((await console_('POST', '/tenants', company)).json()).toMatchObject({ slug: 'panaderia-corteza-2' })
    expect((await console_('POST', '/tenants', { ...company, taxId: '123' })).json()).toEqual({ error: 'invalid_request' })
  })

  it('cannot go live without a number', async () => {
    expect((await console_('PUT', `/tenants/${tenantId}/status`, { status: 'active' })).json()).toEqual({ error: 'no_channel' })
  })

  it('reads the account numbers and tells which one is already another company\'s', async () => {
    const found = await console_('POST', `/tenants/${tenantId}/channels/lookup`, { wabaId: '300000000000001', accessToken: TOKEN })
    expect(found.json()).toMatchObject({
      wabaTakenBy: null,
      numbers: [
        { phoneNumberId: '400000000000001', takenBy: null, alreadyHere: false },
        { phoneNumberId: other.phoneNumberId, takenBy: 'Empresa B', alreadyHere: false },
      ],
    })
  })

  it('connects a number: token stored encrypted, app subscribed, company awaiting its test', async () => {
    const number = { wabaId: '300000000000001', accessToken: TOKEN, phoneNumberId: '400000000000001', displayNumber: '+58 241-555-0101', label: 'Ventas' }
    const connected = await console_('POST', `/tenants/${tenantId}/channels`, number)
    expect(connected.statusCode).toBe(201)
    const body = connected.json<{ id: string; subscribed: boolean }>()
    channelId = body.id
    expect(body.subscribed).toBe(true)
    const [stored] = await t.db.select().from(channelCredentials).where(eq(channelCredentials.channelAccountId, channelId))
    expect(JSON.stringify(stored)).not.toContain(TOKEN)
    const detail = (await console_('GET', `/tenants/${tenantId}`)).json<{ status: string; channels: Record<string, unknown>[] }>()
    expect(detail.status).toBe('awaiting_channel')
    expect(detail.channels).toEqual([expect.objectContaining({ label: 'Ventas', hasToken: true })])
    expect(JSON.stringify(detail)).not.toContain(TOKEN)

    expect((await console_('POST', `/tenants/${tenantId}/channels`, { ...number, label: 'Otra' })).json()).toEqual({ error: 'phone_number_taken' })
    expect((await console_('POST', `/tenants/${tenantId}/channels`, { ...number, wabaId: other.wabaId, phoneNumberId: '400000000000009' })).json()).toEqual({
      error: 'waba_taken',
    })
  })

  it('the test sees when the first customer message arrives, not what it says', async () => {
    const since = new Date(Date.now() - 1000).toISOString()
    const before = (await console_('GET', `/tenants/${tenantId}/inbound?since=${encodeURIComponent(since)}`)).json<{ receivedAt: string | null }>()
    expect(before.receivedAt).toBeNull()
    await withTenant(t.db, tenantId, (scope) =>
      new IngestService().recordInbound(scope, channelId, {
        kind: 'inbound_message',
        phoneNumberId: '400000000000001',
        waMessageId: `wamid.${randomUUID()}`,
        timestamp: new Date(),
        from: '584125550001',
        profileName: 'Cliente',
        type: 'text',
        body: 'Hola, ¿tienen pan canilla?',
        replyId: null,
        waMediaId: null,
      }),
    )
    const after = await console_('GET', `/tenants/${tenantId}/inbound?since=${encodeURIComponent(since)}`)
    expect(after.json<{ receivedAt: string | null }>().receivedAt).not.toBeNull()
    expect(after.body).not.toContain('canilla')
  })

  it('invites the admin with every number; they enter only once the company is live', async () => {
    const invited = (await console_('POST', `/tenants/${tenantId}/invitations`, { name: 'Juan Pérez', email: 'Juan@Corteza.com' })).json<{ token: string; role: string }>()
    expect(invited.role).toBe('admin')
    const juan = randomUUID()
    const accept = await app.inject({ method: 'POST', url: `/api/invitations/${invited.token}/accept`, headers: await bearer(juan, { email: 'juan@corteza.com' }) })
    expect(accept.json()).toEqual({ tenantId })

    const team = async () => app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/team`, headers: await bearer(juan) })
    expect((await team()).json()).toEqual({ error: 'company_unavailable' })
    expect((await console_('PUT', `/tenants/${tenantId}/status`, { status: 'active' })).statusCode).toBe(204)
    const members = (await team()).json<{ items: { role: string; channelAccountIds: string[] }[] }>().items
    expect(members).toEqual([expect.objectContaining({ role: 'admin', channelAccountIds: [channelId] })])
  })

  it('suspending closes the door without losing anything; reactivating opens it again', async () => {
    const juanTeam = async () => {
      const detail = (await console_('GET', `/tenants/${tenantId}`)).json<{ members: { userId: string }[] }>()
      return app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/team`, headers: await bearer(detail.members[0]!.userId) })
    }
    expect((await console_('PUT', `/tenants/${tenantId}/status`, { status: 'suspended' })).statusCode).toBe(204)
    expect((await juanTeam()).json()).toEqual({ error: 'company_unavailable' })
    expect((await console_('PUT', `/tenants/${tenantId}/status`, { status: 'active' })).statusCode).toBe(204)
    expect((await juanTeam()).statusCode).toBe(200)
  })
})

describe('correcting a connected number', () => {
  it('lists the account numbers with the stored token, and refuses what Meta or the platform says no to', async () => {
    waba.accounts.get('300000000000001')!.push({ phoneNumberId: '400000000000002', displayNumber: '+58 241-555-0102', verifiedName: 'Corteza', nameStatus: 'APPROVED' })
    const found = (await console_('POST', `/tenants/${tenantId}/channels/${channelId}/lookup`, { wabaId: '300000000000001' })).json<{ numbers: { phoneNumberId: string; alreadyHere: boolean }[] }>()
    expect(found.numbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phoneNumberId: '400000000000001', alreadyHere: true }),
        expect.objectContaining({ phoneNumberId: '400000000000002', alreadyHere: false }),
      ]),
    )
    expect((await console_('POST', `/tenants/${tenantId}/channels/${channelId}/lookup`, { wabaId: '300000000000099' })).json()).toEqual({ error: 'meta_refused' })
    expect((await console_('PUT', `/tenants/${tenantId}/channels/${channelId}`, { wabaId: '300000000000001', phoneNumberId: '400000000000777' })).json()).toEqual({ error: 'number_not_in_account' })
    expect((await console_('PUT', `/tenants/${tenantId}/channels/${channelId}`, { wabaId: '300000000000001', phoneNumberId: other.phoneNumberId })).json()).toEqual({ error: 'phone_number_taken' })
    expect((await console_('PUT', `/tenants/${tenantId}/channels/${randomUUID()}`, { wabaId: '300000000000001', phoneNumberId: '400000000000002' })).statusCode).toBe(404)
  })

  it('points the same number at another one: shown as Meta says, conversations kept, messages to the old one no longer arrive', async () => {
    const changed = await console_('PUT', `/tenants/${tenantId}/channels/${channelId}`, { wabaId: '300000000000001', phoneNumberId: '400000000000002' })
    expect(changed.json()).toEqual({ id: channelId, displayNumber: '+58 241-555-0102', subscribed: true })
    const detail = (await console_('GET', `/tenants/${tenantId}`)).json<{ channels: { id: string; displayNumber: string; phoneNumberId?: string }[] }>()
    expect(detail.channels).toEqual([expect.objectContaining({ id: channelId, displayNumber: '+58 241-555-0102' })])
    const route = await new ChannelDirectory(t.db).resolve('400000000000002')
    expect(route).toEqual({ tenantId, channelAccountId: channelId })
    expect(await new ChannelDirectory(t.db).resolve('400000000000001')).toBeNull()
    const kept = await t.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.tenantId, tenantId))
    expect(kept.length).toBeGreaterThan(0)
  })

  it('refreshes the shown number from Meta when it was typed wrong', async () => {
    await t.db.update(channelAccounts).set({ displayNumber: '+58 412-000-0000' }).where(eq(channelAccounts.id, channelId))
    expect((await console_('POST', `/tenants/${tenantId}/channels/${channelId}/refresh`)).json()).toEqual({ displayNumber: '+58 241-555-0102' })
  })
})

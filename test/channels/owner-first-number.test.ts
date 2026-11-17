// A brand-new company connects its first number by itself: our console creates it and invites its
// owner (the company waits for them), the owner can only reach «Conectar con WhatsApp» until then,
// and the company goes live the moment the number is in (decided 17 Nov 2026), with nobody of ours.
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tenants } from '../../src/db/schema/index.ts'
import type { BusinessTokenExchange, TokenGrant } from '../../src/modules/whatsapp/meta-oauth.client.ts'
import { FakeWabaDirectory, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const APP_ID = '1167128472338629'
const WABA = '300000000000021'
const NUMBER = '400000000000021'

class FakeExchange implements BusinessTokenExchange {
  readonly appId = APP_ID
  readonly grant: TokenGrant = { appId: APP_ID, valid: true, expiresAt: new Date('2027-01-15T12:00:00Z'), wabaIds: [WABA] }
  exchangeCode(): Promise<string> {
    return Promise.resolve('EAAG-owner-token-0123456789-abcdef')
  }
  inspect(): Promise<TokenGrant> {
    return Promise.resolve(this.grant)
  }
}

const company = {
  name: 'Ferretería El Tornillo',
  businessType: 'hardware',
  city: 'Valencia',
  plan: 'basic',
  legalName: 'El Tornillo, C.A.',
  taxId: 'J-41234567-8',
  fiscalAddress: 'Av. Bolívar, Valencia',
}

let t: TestDatabase
let app: FastifyInstance
let other: SeededTenant
const waba = new FakeWabaDirectory()
const who = { staff: '', owner: '', agent: '' }
let tenantId = ''

const console_ = async (method: 'POST' | 'GET', path: string, payload?: object) =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(who.staff, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
const panel = async (method: 'GET' | 'POST', path: string, userId = who.owner, payload?: object) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const statusOf = async (id: string) => (await t.db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, id)))[0]!.status

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ b: other } = await seedTwoTenants(t.db))
  who.staff = await seedUser(t.db, 'Yornel', 'super_admin')
  who.owner = await seedUser(t.db, 'Pedro')
  who.agent = await seedUser(t.db, 'Carla')
  waba.accounts.set(WABA, [{ phoneNumberId: NUMBER, displayNumber: '+58 412-555-0188', verifiedName: 'El Tornillo', nameStatus: 'APPROVED' }])
  waba.onBusinessApp.add(NUMBER)
  app = await buildTestApp(t.db, {
    wabaDirectory: waba,
    signup: { exchange: new FakeExchange(), launch: { appId: APP_ID, configId: '3023822601294020', graphVersion: 'v27.0' } },
  })
  tenantId = (await console_('POST', '/tenants', company)).json<{ id: string }>().id
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('our console asks the owner to connect the first number', () => {
  it('invites the owner as admin and the company waits for them', async () => {
    const invited = await console_('POST', `/tenants/${tenantId}/owner-invitation`, { name: 'Pedro Ramírez', email: 'pedro@example.com' })
    expect(invited.statusCode).toBe(201)
    const body = invited.json<{ token: string; role: string }>()
    expect(body.role).toBe('admin')
    expect(body.token.length).toBeGreaterThan(20)
    expect(await statusOf(tenantId)).toBe('awaiting_owner')
  })

  it('only from a draft without a number: not twice, not a working company', async () => {
    expect((await console_('POST', `/tenants/${tenantId}/owner-invitation`, { name: 'Otro', email: 'otro@example.com' })).json()).toEqual({ error: 'not_a_draft' })
    expect((await console_('POST', `/tenants/${other.tenantId}/owner-invitation`, { name: 'Otro', email: 'otro@example.com' })).json()).toEqual({ error: 'not_a_draft' })
  })
})

describe('until the number is in, the owner reaches only «Conectar con WhatsApp»', () => {
  beforeAll(async () => {
    // As if the owner accepted the invitation (the accept flow itself is tested in team tests).
    await seedMembership(t.db, tenantId, who.owner, { role: 'admin' })
    await seedMembership(t.db, tenantId, who.agent, { role: 'agent' })
  })

  it('the owner gets what opens Meta\'s window', async () => {
    expect((await panel('GET', '/channels/signup')).json()).toMatchObject({ available: true, appId: APP_ID })
  })

  it('nothing else of the company opens, and not for someone who is not its admin', async () => {
    expect((await panel('GET', '/team')).json()).toEqual({ error: 'company_unavailable' })
    expect((await panel('GET', '/conversations')).json()).toEqual({ error: 'company_unavailable' })
    expect((await panel('GET', '/channels/signup', who.agent)).json()).toEqual({ error: 'admin_required' })
  })

  it('a plain draft stays closed to its people', async () => {
    const draft = (await console_('POST', '/tenants', { ...company, name: 'Borrador' })).json<{ id: string }>().id
    await seedMembership(t.db, draft, who.owner, { role: 'admin' })
    const asked = await app.inject({ method: 'GET', url: `/api/tenants/${draft}/channels/signup`, headers: await bearer(who.owner) })
    expect(asked.json()).toEqual({ error: 'company_unavailable' })
  })
})

describe('connecting the first number', () => {
  it('the company goes live by itself and the whole panel opens', async () => {
    const connected = await panel('POST', '/channels/signup', who.owner, { code: 'good-owner-code', wabaId: WABA, phoneNumberId: NUMBER })
    expect(connected.statusCode).toBe(201)
    expect(connected.json()).toMatchObject({ activated: true, coexistence: true, displayNumber: '+58 412-555-0188' })
    expect(await statusOf(tenantId)).toBe('active')
    expect((await panel('GET', '/team')).statusCode).toBe(200)
  })

  it('a second number of a live company activates nothing again', async () => {
    const again = await panel('POST', '/channels/signup', who.owner, { code: 'good-owner-code-2', wabaId: WABA, phoneNumberId: NUMBER })
    expect(again.json()).toMatchObject({ activated: false })
  })
})

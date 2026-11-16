// «Conectar WhatsApp»: a company's admin connects its own number with Meta's Embedded Signup. The
// code is exchanged on the server, the token must be our app's and grant the account named, the
// number must be in it and no other company's; a WhatsApp Business app number (coexistence) is not
// registered again and its contacts and history are asked for; the token is kept encrypted.
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { channelAccounts, channelCredentials } from '../../src/db/schema/index.ts'
import { WhatsAppApiError } from '../../src/modules/whatsapp/cloud-api.client.ts'
import type { BusinessTokenExchange, TokenGrant } from '../../src/modules/whatsapp/meta-oauth.client.ts'
import { FakeWabaDirectory, buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const APP_ID = '1167128472338629'
const WABA = '300000000000011'
const COEXISTENCE_NUMBER = '400000000000011'
const NEW_NUMBER = '400000000000012'
const TOKEN = 'EAAG-business-token-from-signup-0123456789'
const EXPIRES = new Date('2027-01-15T12:00:00Z')

/** Stands in for Meta's OAuth: one code works once and becomes TOKEN, granted as the test says. */
class FakeExchange implements BusinessTokenExchange {
  readonly appId = APP_ID
  grant: TokenGrant = { appId: APP_ID, valid: true, expiresAt: EXPIRES, wabaIds: [WABA] }
  private readonly used = new Set<string>()

  exchangeCode(code: string): Promise<string> {
    if (!code.startsWith('good-') || this.used.has(code)) return Promise.reject(new WhatsAppApiError('Invalid code', 400, 100))
    this.used.add(code)
    return Promise.resolve(TOKEN)
  }

  inspect(): Promise<TokenGrant> {
    return Promise.resolve(this.grant)
  }
}

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const waba = new FakeWabaDirectory()
const exchange = new FakeExchange()
const who = { admin: '', agent: '' }
let codes = 0

const signup = async (body: object, userId = who.admin, tenantId = a.tenantId) =>
  app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/channels/signup`, headers: await bearer(userId), payload: body })
const connect = (phoneNumberId: string, extra: object = {}) => signup({ code: `good-${++codes}-code`, wabaId: WABA, phoneNumberId, ...extra })

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.admin = await seedUser(t.db, 'Juan')
  who.agent = await seedUser(t.db, 'Carla')
  await seedMembership(t.db, a.tenantId, who.admin, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.agent, { role: 'agent' })
  waba.accounts.set(WABA, [
    { phoneNumberId: COEXISTENCE_NUMBER, displayNumber: '+58 412-555-0111', verifiedName: 'Panadería Corteza', nameStatus: 'APPROVED' },
    { phoneNumberId: NEW_NUMBER, displayNumber: '+58 412-555-0112', verifiedName: 'Corteza Delivery', nameStatus: 'APPROVED' },
    { phoneNumberId: b.phoneNumberId, displayNumber: '+58 412-555-0199', verifiedName: 'Ajeno', nameStatus: 'APPROVED' },
  ])
  waba.onBusinessApp.add(COEXISTENCE_NUMBER)
  app = await buildTestApp(t.db, { wabaDirectory: waba, signup: { exchange, launch: { appId: APP_ID, configId: '3023822601294020', graphVersion: 'v27.0' } } })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

beforeEach(() => {
  exchange.grant = { appId: APP_ID, valid: true, expiresAt: EXPIRES, wabaIds: [WABA] }
})

describe('who may connect a number', () => {
  it('the panel gets what it needs to open Meta\'s window, admins only', async () => {
    const launch = await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/channels/signup`, headers: await bearer(who.admin) })
    expect(launch.json()).toEqual({ available: true, appId: APP_ID, configId: '3023822601294020', graphVersion: 'v27.0' })
    const asAgent = await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/channels/signup`, headers: await bearer(who.agent) })
    expect(asAgent.json()).toEqual({ error: 'admin_required' })
    expect((await signup({ code: 'good-x-code', wabaId: WABA, phoneNumberId: NEW_NUMBER }, who.agent)).json()).toEqual({ error: 'admin_required' })
  })

  it('nobody connects into a company they do not belong to', async () => {
    expect((await signup({ code: 'good-y-code', wabaId: WABA, phoneNumberId: NEW_NUMBER }, who.admin, b.tenantId)).json()).toEqual({ error: 'not_a_member' })
  })

  it('without the signup app configured the button is not offered', async () => {
    const plain = await buildTestApp(t.db)
    const launch = await plain.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/channels/signup`, headers: await bearer(who.admin) })
    expect(launch.json()).toEqual({ available: false })
    const posted = await plain.inject({
      method: 'POST',
      url: `/api/tenants/${a.tenantId}/channels/signup`,
      headers: await bearer(who.admin),
      payload: { code: 'good-z-code', wabaId: WABA, phoneNumberId: NEW_NUMBER },
    })
    expect(posted.json()).toEqual({ error: 'signup_unavailable' })
    await plain.close()
  })
})

describe('connecting the owner\'s WhatsApp Business app number (coexistence)', () => {
  it('stores it encrypted, does not register it again, subscribes the app and asks for contacts and history', async () => {
    const connected = await connect(COEXISTENCE_NUMBER)
    expect(connected.statusCode).toBe(201)
    expect(connected.json()).toMatchObject({ coexistence: true, subscribed: true, syncRequested: ['smb_app_state_sync', 'history'] })
    const [row] = await t.db.select().from(channelAccounts).where(eq(channelAccounts.phoneNumberId, COEXISTENCE_NUMBER))
    expect(row).toMatchObject({ tenantId: a.tenantId, wabaId: WABA, label: 'Panadería Corteza', coexistence: true, status: 'connected', tokenExpiresAt: EXPIRES })
    const [stored] = await t.db.select().from(channelCredentials).where(eq(channelCredentials.channelAccountId, row!.id))
    expect(stored!.encryptedTwoStepPin).toBeNull()
    expect(JSON.stringify(stored)).not.toContain(TOKEN)
    expect(waba.registered.map((r) => r.phoneNumberId)).not.toContain(COEXISTENCE_NUMBER)
    expect(waba.subscribed).toContain(WABA)
    expect(waba.syncs).toEqual([
      { phoneNumberId: COEXISTENCE_NUMBER, kind: 'smb_app_state_sync' },
      { phoneNumberId: COEXISTENCE_NUMBER, kind: 'history' },
    ])
  })

  it('the panel lists it as coexistence with the date its connection expires; never the token', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/channels`, headers: await bearer(who.admin) })
    expect(list.json<{ items: unknown[] }>().items).toContainEqual(
      expect.objectContaining({ phoneNumberId: COEXISTENCE_NUMBER, coexistence: true, tokenExpiresAt: EXPIRES.toISOString() }),
    )
    expect(list.body).not.toContain(TOKEN)
  })

  it('connecting it again renews the token on the same row instead of adding it twice', async () => {
    exchange.grant = { ...exchange.grant, expiresAt: new Date('2027-03-01T00:00:00Z') }
    const again = await connect(COEXISTENCE_NUMBER)
    expect(again.statusCode).toBe(201)
    const rows = await t.db.select().from(channelAccounts).where(eq(channelAccounts.phoneNumberId, COEXISTENCE_NUMBER))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenExpiresAt).toEqual(new Date('2027-03-01T00:00:00Z'))
  })
})

describe('connecting a new number (not on the WhatsApp Business app)', () => {
  it('registers it with a 6-digit PIN kept encrypted, and asks for nothing from an app it is not on', async () => {
    const connected = await connect(NEW_NUMBER)
    expect(connected.statusCode).toBe(201)
    expect(connected.json()).toMatchObject({ displayNumber: '+58 412-555-0112', coexistence: false, subscribed: true, syncRequested: [] })
    const registration = waba.registered.find((r) => r.phoneNumberId === NEW_NUMBER)
    expect(registration?.pin).toMatch(/^\d{6}$/)
    const [row] = await t.db.select().from(channelAccounts).where(eq(channelAccounts.phoneNumberId, NEW_NUMBER))
    const [stored] = await t.db.select().from(channelCredentials).where(eq(channelCredentials.channelAccountId, row!.id))
    expect(stored!.encryptedTwoStepPin).toBeTruthy()
    expect(stored!.encryptedTwoStepPin).not.toContain(registration!.pin)
    expect(waba.syncs.some((s) => s.phoneNumberId === NEW_NUMBER)).toBe(false)
  })
})

describe('what is refused', () => {
  it('an expired or reused code', async () => {
    expect((await signup({ code: 'bad-code-from-elsewhere', wabaId: WABA, phoneNumberId: NEW_NUMBER })).json()).toEqual({ error: 'signup_code_rejected' })
    const code = `good-${++codes}-code`
    await signup({ code, wabaId: WABA, phoneNumberId: NEW_NUMBER })
    expect((await signup({ code, wabaId: WABA, phoneNumberId: NEW_NUMBER })).json()).toEqual({ error: 'signup_code_rejected' })
  })

  it('a token of another app, an invalid one, or one that does not grant the account named', async () => {
    exchange.grant = { ...exchange.grant, appId: '999999999999' }
    expect((await connect(NEW_NUMBER)).json()).toEqual({ error: 'signup_grant_mismatch' })
    exchange.grant = { ...exchange.grant, appId: APP_ID, valid: false }
    expect((await connect(NEW_NUMBER)).json()).toEqual({ error: 'signup_grant_mismatch' })
    exchange.grant = { ...exchange.grant, valid: true, wabaIds: ['300000000000099'] }
    expect((await connect(NEW_NUMBER)).json()).toEqual({ error: 'signup_grant_mismatch' })
  })

  it('a number of another company, or one that is not in the account', async () => {
    expect((await connect(b.phoneNumberId)).json()).toEqual({ error: 'phone_number_taken' })
    expect((await connect('400000000000077')).json()).toEqual({ error: 'number_not_in_account' })
  })

  it('an account another company already uses', async () => {
    exchange.grant = { ...exchange.grant, wabaIds: [b.wabaId] }
    waba.accounts.set(b.wabaId, [{ phoneNumberId: '400000000000088', displayNumber: '+58 412-555-0188', verifiedName: 'B', nameStatus: 'APPROVED' }])
    expect((await signup({ code: `good-${++codes}-code`, wabaId: b.wabaId, phoneNumberId: '400000000000088' })).json()).toEqual({ error: 'waba_taken' })
  })

  it('malformed input never reaches Meta', async () => {
    expect((await signup({ code: 'good code with spaces', wabaId: WABA, phoneNumberId: NEW_NUMBER })).json()).toEqual({ error: 'invalid_request' })
    expect((await signup({ code: `good-${++codes}-code`, wabaId: '../me', phoneNumberId: NEW_NUMBER })).json()).toEqual({ error: 'invalid_request' })
  })
})

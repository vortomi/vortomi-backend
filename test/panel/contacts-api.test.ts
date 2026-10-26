// Contacts typed by hand and imported from a file: only on numbers the person attends, never
// on another company's, the same phone once per number, and an import that keeps what is known.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', ana: '' }
let tagId = ''

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.ana = await seedUser(t.db, 'Ana')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  // Ana is an agent with no number assigned.
  await seedMembership(t.db, a.tenantId, who.ana)
  app = await buildTestApp(t.db)
  tagId = (await call(who.laura, 'POST', '/tags', { name: 'Mayorista', tone: 'blue' })).json<{ id: string }>().id
})

afterAll(async () => {
  await app.close()
  await t.close()
})

async function call(userId: string, method: 'GET' | 'POST', path: string, payload?: object) {
  return app.inject({ method, url: `/api/tenants/${a.tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
}

describe('a contact typed by hand', () => {
  it('an agent adds one on their number; the phone is stored as digits; twice is refused', async () => {
    const contact = { channelAccountId: a.channelAccountId, waId: '+58 412-555-0101', name: 'María López', tagIds: [tagId] }
    const created = await call(who.carlos, 'POST', '/contacts', contact)
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ waId: '584125550101', name: 'María López', tagIds: [tagId] })
    expect((await call(who.carlos, 'POST', '/contacts', contact)).json()).toEqual({ error: 'contact_exists' })
  })

  it('not on a number the person does not attend, nor on another company\'s', async () => {
    const contact = { channelAccountId: a.channelAccountId, waId: '584125550102' }
    expect((await call(who.ana, 'POST', '/contacts', contact)).json()).toEqual({ error: 'channel_not_attended' })
    expect((await call(who.laura, 'POST', '/contacts', { ...contact, channelAccountId: b.channelAccountId })).json()).toEqual({ error: 'unknown_channel' })
    expect((await call(who.laura, 'POST', '/contacts', { ...contact, waId: '123' })).statusCode).toBe(400)
  })
})

describe('importing a list', () => {
  it('is for admins; creates the new phones, keeps known names and adds the tags', async () => {
    const rows = [
      { waId: '58 412 555 0101', name: 'Otro nombre', tagIds: [tagId] },
      { waId: '584125550201', name: 'Pedro Ruiz', tagIds: [tagId] },
      { waId: '584125550202', name: null, tagIds: [] },
    ]
    const payload = { channelAccountId: a.channelAccountId, rows }
    expect((await call(who.carlos, 'POST', '/contacts/import', payload)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/contacts/import', payload)).json()).toEqual({ created: 2, updated: 1 })
    const list = (await call(who.laura, 'GET', '/contacts')).json<{ items: { waId: string; name: string | null; tagIds: string[] }[] }>().items
    expect(list.find((c) => c.waId === '584125550101')).toMatchObject({ name: 'María López', tagIds: [tagId] })
    expect(list.find((c) => c.waId === '584125550201')).toMatchObject({ name: 'Pedro Ruiz', tagIds: [tagId] })
  })

  it('an unknown tag stops the whole import: nothing is saved', async () => {
    const rows = [{ waId: '584125550301', name: 'Nadie', tagIds: ['00000000-0000-4000-8000-000000000000'] }]
    expect((await call(who.laura, 'POST', '/contacts/import', { channelAccountId: a.channelAccountId, rows })).json()).toEqual({ error: 'unknown_tag' })
    const list = (await call(who.laura, 'GET', '/contacts')).json<{ items: { waId: string }[] }>().items
    expect(list.some((c) => c.waId === '584125550301')).toBe(false)
  })
})

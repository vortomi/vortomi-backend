// How a company works: settings, quick replies and its pipeline. Everyone reads,
// admins change, and nothing of one company can be used by another.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
let contactId: string
const who = { laura: '', carlos: '', pedro: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin', channelAccountIds: [b.channelAccountId] })
  const event = {
    kind: 'inbound_message' as const,
    phoneNumberId: a.phoneNumberId,
    waMessageId: `wamid.${randomUUID()}`,
    timestamp: new Date(),
    from: '584120000001',
    profileName: 'Cliente',
    type: 'text' as const,
    body: 'Hola',
    replyId: null,
    waMediaId: null,
  }
  contactId = (await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))).contactId
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: '08:00', close: '17:00' }))

describe('company profile', () => {
  it('admins rename their company and set its time zone; agents cannot; another company is untouched', async () => {
    const profile = { name: 'Repuestos Andinos', timezone: 'America/Bogota' }
    expect((await call(who.carlos, 'PUT', '/profile', profile)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', '/profile', profile)).json()).toEqual(profile)
    expect((await call(who.laura, 'PUT', '/profile', { ...profile, timezone: 'Mars/Olympus' })).statusCode).toBe(400)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: await bearer(who.pedro) })
    expect(me.json<{ companies: { name: string; timezone: string }[] }>().companies[0]).toMatchObject({ name: 'Empresa B', timezone: 'America/Caracas' })
  })
})

describe('settings', () => {
  it('start with the defaults: sales and support, nothing else to configure', async () => {
    expect((await call(who.carlos, 'GET', '/settings')).json()).toEqual({
      workMode: 'sales_and_support',
      businessHours: [],
      awayMessage: '',
    })
  })

  it('only admins change them', async () => {
    const payload = { workMode: 'support_only', businessHours: weekdays, awayMessage: 'Ya cerramos' }
    expect((await call(who.carlos, 'PUT', '/settings', payload)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', '/settings', payload)).json()).toEqual(payload)
    expect((await call(who.carlos, 'GET', '/settings')).json()).toMatchObject({ workMode: 'support_only', awayMessage: 'Ya cerramos' })
  })

  it('rejects impossible business hours', async () => {
    const base = { workMode: 'sales_and_support', awayMessage: '' }
    expect((await call(who.laura, 'PUT', '/settings', { ...base, businessHours: [{ day: 1, open: '18:00', close: '08:00' }] })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', '/settings', { ...base, businessHours: [weekdays[0], weekdays[0]] })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', '/settings', { ...base, businessHours: [{ day: 7, open: null, close: null }] })).statusCode).toBe(400)
  })

  it('are per company', async () => {
    expect((await call(who.pedro, 'GET', '/settings', undefined, b.tenantId)).json()).toMatchObject({ workMode: 'sales_and_support' })
  })
})

describe('quick replies', () => {
  let replyId: string

  it('admins create them; the shortcut is unique ignoring case', async () => {
    const created = await call(who.laura, 'POST', '/quick-replies', { shortcut: 'Envio', title: 'Envío', body: 'Enviamos por MRW' })
    expect(created.statusCode).toBe(201)
    replyId = created.json<{ id: string; shortcut: string }>().id
    expect(created.json()).toMatchObject({ shortcut: 'envio' })
    expect((await call(who.laura, 'POST', '/quick-replies', { shortcut: 'ENVIO', title: 'Otra', body: 'Otra' })).json()).toEqual({ error: 'shortcut_taken' })
    expect((await call(who.carlos, 'POST', '/quick-replies', { shortcut: 'pago', title: 'Pago', body: 'Pago móvil' })).json()).toEqual({ error: 'admin_required' })
  })

  it('everyone reads them; another company cannot touch them', async () => {
    expect((await call(who.carlos, 'GET', '/quick-replies')).json<{ items: unknown[] }>().items).toHaveLength(1)
    expect((await call(who.pedro, 'GET', '/quick-replies', undefined, b.tenantId)).json<{ items: unknown[] }>().items).toHaveLength(0)
    const intrusion = await call(who.pedro, 'DELETE', `/quick-replies/${replyId}`, undefined, b.tenantId)
    expect(intrusion.json()).toEqual({ error: 'quick_reply_not_found' })
  })
})

describe('pipeline', () => {
  const stage = { lead: '', quoted: '' }

  it('new stages go last and can be reordered', async () => {
    stage.lead = (await call(who.laura, 'POST', '/pipeline/stages', { name: 'Nuevo', color: '#4f63f0' })).json<{ id: string }>().id
    stage.quoted = (await call(who.laura, 'POST', '/pipeline/stages', { name: 'Cotizado', color: '#f59e0b' })).json<{ id: string }>().id
    expect((await call(who.carlos, 'GET', '/pipeline/stages')).json<{ items: { name: string; position: number }[] }>().items).toEqual([
      expect.objectContaining({ name: 'Nuevo', position: 0 }),
      expect.objectContaining({ name: 'Cotizado', position: 1 }),
    ])
    const reordered = await call(who.laura, 'PUT', '/pipeline/order', { stageIds: [stage.quoted, stage.lead] })
    expect(reordered.json<{ items: { name: string }[] }>().items.map((s) => s.name)).toEqual(['Cotizado', 'Nuevo'])
    expect((await call(who.laura, 'PUT', '/pipeline/order', { stageIds: [stage.lead] })).statusCode).toBe(404)
  })

  it('anyone who sees the contact moves it and sets the quote', async () => {
    expect((await call(who.carlos, 'PUT', `/contacts/${contactId}/opportunity`, { stageId: stage.quoted, quoteCents: 125_000 })).statusCode).toBe(204)
    expect((await call(who.carlos, 'GET', `/contacts/${contactId}`)).json()).toMatchObject({ stageId: stage.quoted, quoteCents: 125_000 })
  })

  it('cannot use a stage of another company', async () => {
    const foreign = (await call(who.pedro, 'POST', '/pipeline/stages', { name: 'Ajena', color: '#000000' }, b.tenantId)).json<{ id: string }>().id
    expect((await call(who.laura, 'PUT', `/contacts/${contactId}/opportunity`, { stageId: foreign, quoteCents: null })).json()).toEqual({
      error: 'stage_not_found',
    })
  })

  it('a stage that still holds contacts cannot be deleted', async () => {
    expect((await call(who.laura, 'DELETE', `/pipeline/stages/${stage.quoted}`)).json()).toEqual({ error: 'stage_in_use' })
    await call(who.laura, 'PUT', `/contacts/${contactId}/opportunity`, { stageId: null, quoteCents: null })
    expect((await call(who.laura, 'DELETE', `/pipeline/stages/${stage.quoted}`)).statusCode).toBe(204)
  })
})

// «Ajustes → Agente» and «Devolver al agente» over HTTP: admins only, validated, per company.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conversations } from '../../src/db/schema/index.ts'
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
const who = { laura: '', carlos: '', pedro: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})
afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'PUT' | 'DELETE', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const settings = { enabled: true, assistantName: '  Ana ', tone: 'formal', schedule: 'after_hours', businessInfo: 'Av. Bolívar, Valencia.' }

describe('agent settings', () => {
  it('starts off, with nothing used this month', async () => {
    expect((await call(who.laura, 'GET', '/agent')).json()).toMatchObject({ enabled: false, assistantName: 'Asistente', tone: 'friendly', schedule: 'always', usage: { replies: 0 } })
  })

  it('an admin turns it on for their company only', async () => {
    const saved = await call(who.laura, 'PUT', '/agent', settings)
    expect(saved.json()).toMatchObject({ enabled: true, assistantName: 'Ana', tone: 'formal', schedule: 'after_hours' })
    expect((await call(who.pedro, 'GET', '/agent', undefined, b.tenantId)).json()).toMatchObject({ enabled: false })
  })

  it('agents cannot see or change it, and closed lists are enforced', async () => {
    expect((await call(who.carlos, 'GET', '/agent')).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.carlos, 'PUT', '/agent', settings)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', '/agent', { ...settings, tone: 'rude' })).statusCode).toBe(400)
    expect((await call(who.laura, 'PUT', '/agent', { ...settings, assistantName: '' })).statusCode).toBe(400)
  })
})

describe('handing a conversation back to the agent', () => {
  it('an admin clears the hand-off; an agent cannot', async () => {
    const event = { kind: 'inbound_message' as const, phoneNumberId: a.phoneNumberId, waMessageId: 'wamid.handoff.1', timestamp: new Date(), from: '584121234567', profileName: 'Cliente', type: 'text' as const, body: 'Quiero comprar', replyId: null, waMediaId: null }
    const { conversationId } = await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))
    await t.db.update(conversations).set({ handoffAt: new Date(), handoffReason: 'purchase' }).where(eq(conversations.id, conversationId))
    expect((await call(who.laura, 'GET', `/conversations/${conversationId}`)).json()).toMatchObject({ handoffReason: 'purchase' })

    expect((await call(who.carlos, 'DELETE', `/conversations/${conversationId}/handoff`)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'DELETE', `/conversations/${conversationId}/handoff`)).statusCode).toBe(204)
    expect((await call(who.laura, 'GET', `/conversations/${conversationId}`)).json()).toMatchObject({ handoffReason: null, handoffAt: null })
  })

  it('resolving the conversation also gives it back: the customer who writes again is answered', async () => {
    const event = { kind: 'inbound_message' as const, phoneNumberId: a.phoneNumberId, waMessageId: 'wamid.handoff.2', timestamp: new Date(), from: '584121234568', profileName: 'Cliente', type: 'text' as const, body: 'Gracias', replyId: null, waMediaId: null }
    const { conversationId } = await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))
    await t.db.update(conversations).set({ handoffAt: new Date(), handoffReason: 'order_placed' }).where(eq(conversations.id, conversationId))
    await call(who.laura, 'PUT', `/conversations/${conversationId}/status`, { status: 'open' })
    expect((await call(who.laura, 'GET', `/conversations/${conversationId}`)).json()).toMatchObject({ handoffReason: 'order_placed' })

    expect((await call(who.laura, 'PUT', `/conversations/${conversationId}/status`, { status: 'resolved' })).statusCode).toBe(204)
    expect((await call(who.laura, 'GET', `/conversations/${conversationId}`)).json()).toMatchObject({ status: 'resolved', handoffReason: null, handoffAt: null })
  })
})

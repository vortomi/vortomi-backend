// The panel's inbox over HTTP: who sees which conversation inside a company, and
// what each person can change. The company boundary itself is covered by test/db.
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { channelAccounts, conversations, tags } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { buildTestApp } from '../helpers/app.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
let workshopId: string
const ingest = new IngestService()
const who = { laura: '', carlos: '', andrea: '', pedro: '' }
const chats = { c1: '', c2: '', c3: '', cb: '' }

let clock = Date.parse('2026-10-15T12:00:00Z')
function inbound(phoneNumberId: string, from: string, body: string, waMessageId = `wamid.${randomUUID()}`): InboundMessageEvent {
  clock += 60_000
  return { kind: 'inbound_message', phoneNumberId, waMessageId, timestamp: new Date(clock), from, profileName: `Cliente ${from.slice(-2)}`, type: 'text', body, replyId: null, waMediaId: null }
}
const receive = (tenant: SeededTenant, channelAccountId: string, event: InboundMessageEvent) =>
  withTenant(t.db, tenant.tenantId, (scope) => ingest.recordInbound(scope, channelAccountId, event))
const assignDirectly = (tenantId: string, conversationId: string, userId: string) =>
  withTenant(t.db, tenantId, ({ tx }) => tx.update(conversations).set({ assignedUserId: userId }).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId))))

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  const [workshop] = await t.db
    .insert(channelAccounts)
    .values({ tenantId: a.tenantId, wabaId: a.wabaId, phoneNumberId: '100000000000003', displayNumber: '+58 412-555-0103', label: 'Taller' })
    .returning({ id: channelAccounts.id })
  workshopId = workshop!.id

  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.andrea = await seedUser(t.db, 'Andrea')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId, workshopId] })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, who.andrea, { canSeeOthers: true, channelAccountIds: [workshopId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin', channelAccountIds: [b.channelAccountId] })

  // c1: sales number, unassigned, two messages. c2: sales, assigned to Laura. c3: workshop, Andrea's.
  chats.c1 = (await receive(a, a.channelAccountId, inbound(a.phoneNumberId, '584120000001', 'Hola'))).conversationId
  await receive(a, a.channelAccountId, inbound(a.phoneNumberId, '584120000001', '¿Tienen pastillas de freno?'))
  chats.c2 = (await receive(a, a.channelAccountId, inbound(a.phoneNumberId, '584120000002', 'Buenas'))).conversationId
  chats.c3 = (await receive(a, workshopId, inbound('100000000000003', '584120000003', 'Cita para el carro'))).conversationId
  chats.cb = (await receive(b, b.channelAccountId, inbound(b.phoneNumberId, '584120000009', 'Mensaje de la empresa B'))).conversationId
  await assignDirectly(a.tenantId, chats.c2, who.laura)
  await assignDirectly(a.tenantId, chats.c3, who.andrea)

  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  app.inject({ method, url: `/api/tenants/${a.tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id).sort()

describe('who sees which conversation', () => {
  it('admin sees the whole company, and nothing of the other company', async () => {
    const response = await call(who.laura, 'GET', '/conversations')
    expect(response.statusCode).toBe(200)
    expect(ids(response.json())).toEqual([chats.c1, chats.c2, chats.c3].sort())
  })

  it('an agent without "see others" only gets unassigned and own chats on their numbers', async () => {
    expect(ids((await call(who.carlos, 'GET', '/conversations')).json())).toEqual([chats.c1])
  })

  it('an agent with "see others" gets everything on their numbers only', async () => {
    expect(ids((await call(who.andrea, 'GET', '/conversations')).json())).toEqual([chats.c3])
  })

  it('a hidden or foreign conversation is simply not found', async () => {
    expect((await call(who.carlos, 'GET', `/conversations/${chats.c2}`)).json()).toEqual({ error: 'conversation_not_found' })
    expect((await call(who.laura, 'GET', `/conversations/${chats.cb}`)).statusCode).toBe(404)
    expect((await call(who.carlos, 'GET', `/conversations/${chats.c2}/messages`)).statusCode).toBe(404)
    expect((await call(who.carlos, 'GET', `/conversations/${chats.c2}/notes`)).statusCode).toBe(404)
  })
})

describe('reading a conversation', () => {
  it('shows the last message, the unread count and the 24 h window', async () => {
    const c1 = (await call(who.carlos, 'GET', `/conversations/${chats.c1}`)).json<Record<string, unknown>>()
    expect(c1).toMatchObject({ unreadCount: 2, status: 'open', assignedUserId: null, channelAccountId: a.channelAccountId })
    expect(c1['lastMessage']).toMatchObject({ direction: 'in', body: '¿Tienen pastillas de freno?' })
    expect(c1['serviceWindowExpiresAt']).toEqual(expect.any(String))
  })

  it('pages the messages newest first', async () => {
    const first = (await call(who.carlos, 'GET', `/conversations/${chats.c1}/messages?limit=1`)).json<{ items: { body: string }[]; nextBeforeId: number }>()
    expect(first.items.map((m) => m.body)).toEqual(['¿Tienen pastillas de freno?'])
    const second = (await call(who.carlos, 'GET', `/conversations/${chats.c1}/messages?limit=1&beforeId=${first.nextBeforeId}`)).json<{ items: { body: string }[]; nextBeforeId: null }>()
    expect(second.items.map((m) => m.body)).toEqual(['Hola'])
    expect(second.nextBeforeId).toBeNull()
  })

  it('marks it read for the whole team', async () => {
    expect((await call(who.carlos, 'POST', `/conversations/${chats.c1}/read`)).statusCode).toBe(204)
    expect((await call(who.laura, 'GET', `/conversations/${chats.c1}`)).json()).toMatchObject({ unreadCount: 0 })
  })

  it('pages the inbox without repeating or skipping', async () => {
    const first = (await call(who.laura, 'GET', '/conversations?limit=2')).json<{ items: { id: string }[]; nextCursor: string }>()
    const second = (await call(who.laura, 'GET', `/conversations?limit=2&cursor=${first.nextCursor}`)).json<{ items: { id: string }[]; nextCursor: null }>()
    expect([...first.items, ...second.items].map((c) => c.id).sort()).toEqual([chats.c1, chats.c2, chats.c3].sort())
    expect(second.nextCursor).toBeNull()
  })

  it('rejects malformed filters with 400', async () => {
    expect((await call(who.laura, 'GET', '/conversations?view=everything')).json()).toEqual({ error: 'invalid_request' })
  })
})

describe('assigning and resolving', () => {
  it('only to someone of this company who attends that number', async () => {
    const toAndrea = await call(who.carlos, 'PUT', `/conversations/${chats.c1}/assignee`, { userId: who.andrea })
    expect(toAndrea.json()).toEqual({ error: 'assignee_cannot_attend' })
    const toPedro = await call(who.carlos, 'PUT', `/conversations/${chats.c1}/assignee`, { userId: who.pedro })
    expect(toPedro.json()).toEqual({ error: 'assignee_cannot_attend' })
  })

  it('an agent takes a conversation and finds it in "mine"', async () => {
    expect((await call(who.carlos, 'PUT', `/conversations/${chats.c1}/assignee`, { userId: who.carlos })).statusCode).toBe(204)
    expect(ids((await call(who.carlos, 'GET', '/conversations?view=mine')).json())).toEqual([chats.c1])
  })

  it('a resolved conversation leaves the working views and comes back with a new message', async () => {
    await call(who.carlos, 'PUT', `/conversations/${chats.c1}/status`, { status: 'resolved' })
    expect(ids((await call(who.carlos, 'GET', '/conversations?view=mine')).json())).toEqual([])

    const replay = inbound(a.phoneNumberId, '584120000001', 'Hola', 'wamid.replayed')
    await receive(a, a.channelAccountId, replay)
    await call(who.carlos, 'PUT', `/conversations/${chats.c1}/status`, { status: 'resolved' })
    // Meta delivering the same message again must not reopen it.
    await receive(a, a.channelAccountId, replay)
    expect((await call(who.carlos, 'GET', `/conversations/${chats.c1}`)).json()).toMatchObject({ status: 'resolved' })

    await receive(a, a.channelAccountId, inbound(a.phoneNumberId, '584120000001', 'Otra pregunta'))
    expect((await call(who.carlos, 'GET', `/conversations/${chats.c1}`)).json()).toMatchObject({ status: 'open' })
  })
})

describe('internal notes', () => {
  it('are added and listed with their author and mention', async () => {
    const created = await call(who.carlos, 'POST', `/conversations/${chats.c1}/notes`, { body: 'Cliente frecuente', mentionUserId: who.laura })
    expect(created.statusCode).toBe(201)
    const { items } = (await call(who.laura, 'GET', `/conversations/${chats.c1}/notes`)).json<{ items: Record<string, unknown>[] }>()
    expect(items).toEqual([expect.objectContaining({ body: 'Cliente frecuente', authorUserId: who.carlos, mentionUserId: who.laura })])
  })

  it('cannot mention someone of another company', async () => {
    expect((await call(who.carlos, 'POST', `/conversations/${chats.c1}/notes`, { body: 'Hola', mentionUserId: who.pedro })).json()).toEqual({ error: 'mention_not_member' })
  })
})

describe('contacts and tags', () => {
  let contactId: string

  it('lists only contacts of the numbers the agent attends', async () => {
    const { items } = (await call(who.andrea, 'GET', '/contacts')).json<{ items: { waId: string; id: string }[] }>()
    expect(items.map((c) => c.waId)).toEqual(['584120000003'])
    contactId = (await call(who.laura, 'GET', '/contacts?search=000001')).json<{ items: { id: string }[] }>().items[0]!.id
  })

  it('renames a contact and finds it by the new name; wildcards are literal', async () => {
    expect((await call(who.carlos, 'PUT', `/contacts/${contactId}/name`, { name: 'Pedro Pérez' })).statusCode).toBe(204)
    expect((await call(who.carlos, 'GET', '/conversations?search=pérez')).json<{ items: unknown[] }>().items).toHaveLength(1)
    expect((await call(who.carlos, 'GET', '/conversations?search=%25')).json<{ items: unknown[] }>().items).toHaveLength(0)
  })

  it('only admins manage the tag list; names are unique ignoring case', async () => {
    expect((await call(who.carlos, 'POST', '/tags', { name: 'VIP' })).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/tags', { name: 'VIP', tone: 'violet' })).statusCode).toBe(201)
    expect((await call(who.laura, 'POST', '/tags', { name: 'vip' })).json()).toEqual({ error: 'tag_name_taken' })
  })

  it('tags a contact and filters the inbox by tag', async () => {
    const [vip] = (await call(who.carlos, 'GET', '/tags')).json<{ items: { id: string }[] }>().items
    expect((await call(who.carlos, 'PUT', `/contacts/${contactId}/tags`, { tagIds: [vip!.id] })).statusCode).toBe(204)
    expect(ids((await call(who.laura, 'GET', `/conversations?tagId=${vip!.id}`)).json())).toEqual([chats.c1])
  })

  it('cannot use a tag of another company', async () => {
    const foreignTag = await withTenant(t.db, b.tenantId, async ({ tx, tenantId }) => {
      const [row] = await tx.insert(tags).values({ tenantId, name: 'Ajena' }).returning({ id: tags.id })
      return row!.id
    })
    expect((await call(who.laura, 'PUT', `/contacts/${contactId}/tags`, { tagIds: [foreignTag] })).json()).toEqual({ error: 'unknown_tag' })
  })
})

describe('team', () => {
  it('lists this company people; emails only for admins', async () => {
    const asAgent = (await call(who.carlos, 'GET', '/team')).json<{ items: Record<string, unknown>[] }>()
    expect(asAgent.items.map((m) => m['name'])).toEqual(['Andrea', 'Carlos', 'Laura'])
    expect(asAgent.items.every((m) => !('email' in m))).toBe(true)
    const asAdmin = (await call(who.laura, 'GET', '/team')).json<{ items: Record<string, unknown>[] }>()
    expect(asAdmin.items[0]).toMatchObject({ email: 'andrea@example.com', channelAccountIds: [workshopId] })
  })
})

// Reports: per day and person, in the company's time zone, how many conversations were
// attended, how fast the first reply came, how many on time, and the sales closed (moves
// into the last pipeline stage, by whoever made them). Counts only, for admins only.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, messages } from '../../src/db/schema/index.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
const who = { laura: '', carlos: '' }
let firstContact = ''

/** A customer conversation whose first message was stored at `at` (messages are never rewritten, so it is written that way). */
async function conversationAt(waId: string, at: string) {
  const [contact] = await t.db.insert(contacts).values({ tenantId: a.tenantId, channelAccountId: a.channelAccountId, waId }).returning({ id: contacts.id })
  const [conversation] = await t.db.insert(conversations).values({ tenantId: a.tenantId, contactId: contact!.id }).returning({ id: conversations.id })
  await t.db.insert(messages).values({
    tenantId: a.tenantId,
    conversationId: conversation!.id,
    direction: 'in',
    author: 'customer',
    type: 'text',
    body: 'Hola',
    waMessageId: `wamid.${randomUUID()}`,
    createdAt: new Date(at),
  })
  return { contactId: contact!.id, conversationId: conversation!.id }
}

async function replyAt(conversationId: string, userId: string, at: string) {
  await t.db.insert(messages).values({
    tenantId: a.tenantId,
    conversationId,
    direction: 'out',
    author: 'staff',
    authorUserId: userId,
    type: 'text',
    body: 'Sí, tenemos',
    waMessageId: `wamid.${randomUUID()}`,
    createdAt: new Date(at),
  })
}

const report = async (userId: string, from: string, to: string) =>
  app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/reports/days?from=${from}&to=${to}`, headers: await bearer(userId) })

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  app = await buildTestApp(t.db)

  // 20 Oct in Caracas (UTC-4): two answered by Carlos, one waiting with Laura.
  const fast = await conversationAt('584125550001', '2026-10-20T14:00:00Z')
  await replyAt(fast.conversationId, who.carlos, '2026-10-20T14:05:00Z')
  firstContact = fast.contactId
  const slow = await conversationAt('584125550002', '2026-10-20T15:00:00Z')
  await replyAt(slow.conversationId, who.carlos, '2026-10-20T16:00:00Z')
  const waiting = await conversationAt('584125550003', '2026-10-20T15:30:00Z')
  await t.db.update(conversations).set({ assignedUserId: who.laura }).where(eq(conversations.id, waiting.conversationId))
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('attention', () => {
  it('counts per person and day, the first-reply median and the on-time ones', async () => {
    const items = (await report(who.laura, '2026-10-20', '2026-10-20')).json<{ items: Record<string, unknown>[] }>().items
    expect(items).toEqual(
      expect.arrayContaining([
        { date: '2026-10-20', userId: who.carlos, conversations: 2, onTime: 1, firstResponseMedianSec: 1950, wonCount: 0, wonCents: 0 },
        { date: '2026-10-20', userId: who.laura, conversations: 1, onTime: 0, firstResponseMedianSec: null, wonCount: 0, wonCents: 0 },
      ]),
    )
    expect(items).toHaveLength(2)
  })

  it('uses the company calendar: 03:00 UTC on the 21st is still the 20th in Caracas', async () => {
    await conversationAt('584125550004', '2026-10-21T03:00:00Z')
    const items = (await report(who.laura, '2026-10-21', '2026-10-21')).json<{ items: unknown[] }>().items
    expect(items).toEqual([])
  })

  it('is for admins, over a sane range', async () => {
    expect((await report(who.carlos, '2026-10-20', '2026-10-20')).json()).toEqual({ error: 'admin_required' })
    expect((await report(who.laura, '2026-10-21', '2026-10-20')).statusCode).toBe(400)
    expect((await report(who.laura, '2025-01-01', '2026-10-20')).statusCode).toBe(400)
  })
})

describe('sales', () => {
  it('a move into the last stage counts as won for whoever made it, with its quote', async () => {
    const stage = async (name: string) =>
      (await app.inject({ method: 'POST', url: `/api/tenants/${a.tenantId}/pipeline/stages`, headers: await bearer(who.laura), payload: { name, color: '#3b4fd8' } })).json<{ id: string }>().id
    await stage('Cotizado')
    const won = await stage('Vendido')
    const moved = await app.inject({
      method: 'PUT',
      url: `/api/tenants/${a.tenantId}/contacts/${firstContact}/opportunity`,
      headers: await bearer(who.carlos),
      payload: { stageId: won, quoteCents: 5000 },
    })
    expect(moved.statusCode).toBe(204)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date())
    const items = (await report(who.laura, today, today)).json<{ items: Record<string, unknown>[] }>().items
    expect(items).toContainEqual(expect.objectContaining({ userId: who.carlos, wonCount: 1, wonCents: 5000 }))
  })
})

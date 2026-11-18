// One company's «Uso y salud» in the console (mockup web-27): when its customers write, who answers
// and how fast, deliveries, agent, numbers and operation; only that company's figures.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentSettings, agentUsage, contacts, conversations, messageStatusEvents, messages } from '../../src/db/schema/index.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', yornel: '' }

async function chatOf(tenant: SeededTenant, waId = '584120000001'): Promise<string> {
  return withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    const [contact] = await tx.insert(contacts).values({ tenantId, channelAccountId: tenant.channelAccountId, waId }).returning()
    const [conversation] = await tx.insert(conversations).values({ tenantId, contactId: contact!.id, lastActivityAt: new Date() }).returning()
    return conversation!.id
  })
}

async function say(tenant: SeededTenant, conversationId: string, author: 'customer' | 'bot' | 'staff', at: string, delivered = false) {
  const waMessageId = `wamid.${randomUUID()}`
  await withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    await tx.insert(messages).values({
      tenantId, conversationId, waMessageId, direction: author === 'customer' ? 'in' : 'out', author,
      authorUserId: author === 'staff' ? who.laura : null, type: 'text', body: 'x', createdAt: new Date(at),
    })
    if (delivered) await tx.insert(messageStatusEvents).values({ tenantId, waMessageId, status: 'delivered', occurredAt: new Date(at) })
  })
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })

  const chat = await chatOf(a)
  // 11:00 in Caracas: answered by the agent 20 s later, then by Laura.
  await say(a, chat, 'customer', '2026-11-03T15:00:00Z')
  await say(a, chat, 'bot', '2026-11-03T15:00:20Z', true)
  await say(a, chat, 'customer', '2026-11-03T15:10:00Z')
  await say(a, chat, 'staff', '2026-11-03T15:11:00Z', true)
  // 17:00 in Caracas, never answered.
  await say(a, chat, 'customer', '2026-11-04T21:00:00Z')
  await say(b, await chatOf(b), 'customer', '2026-11-03T15:00:00Z')

  await t.db.insert(agentSettings).values({ tenantId: a.tenantId, enabled: true, humanPauseMinutes: 5 })
  await t.db.insert(agentUsage).values([
    { tenantId: a.tenantId, month: '2026-10-01', replies: 16, inputTokens: 53_859, outputTokens: 1_689 },
    { tenantId: a.tenantId, month: '2026-11-01', replies: 19, inputTokens: 94_794, outputTokens: 1_444 },
  ])

  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const usageOf = async (tenantId: string, query = 'from=2026-11-01&to=2026-11-30', userId = who.yornel) =>
  app.inject({ method: 'GET', url: `/api/platform/usage/companies/${tenantId}?${query}`, headers: await bearer(userId, { aal: 'aal2' }) })

describe('one company\'s usage', () => {
  it('counts only that company, by Caracas day and hour', async () => {
    const body = (await usageOf(a.tenantId)).json<Record<string, unknown>>()
    expect(body['tenant']).toMatchObject({ id: a.tenantId, status: 'active' })
    expect(body['days']).toEqual([
      { date: '2026-11-03', fromCustomers: 2, automatic: 1, staff: 1, ownerApp: 0 },
      { date: '2026-11-04', fromCustomers: 1, automatic: 0, staff: 0, ownerApp: 0 },
    ])
    expect(body['hours']).toEqual([
      { hour: 11, fromCustomers: 2, answers: 2 },
      { hour: 17, fromCustomers: 1, answers: 0 },
    ])
  })

  it('times the first answer to each customer message, the agent included, and counts the unanswered', async () => {
    expect((await usageOf(a.tenantId)).json<{ replies: unknown }>().replies).toEqual({ customerMessages: 3, unanswered: 1, medianSec: 40 })
  })

  it('gives deliveries, the team who answered, the agent and its months, numbers and operation', async () => {
    const body = (await usageOf(a.tenantId)).json<Record<string, unknown>>()
    expect(body['delivery']).toEqual({ outbound: 2, delivered: 2, failed: 0 })
    expect(body['staffPeople']).toBe(1)
    expect(body['agent']).toEqual({
      settings: { enabled: true, schedule: 'always', humanPauseMinutes: 5 },
      months: [
        { month: '2026-10', replies: 16, inputTokens: 53_859, outputTokens: 1_689 },
        { month: '2026-11', replies: 19, inputTokens: 94_794, outputTokens: 1_444 },
      ],
    })
    expect(body['numbers']).toMatchObject([{ id: a.channelAccountId, status: 'connected', coexistence: false }])
    expect(body['operation']).toMatchObject({ conversations: 1, open: 1, people: [{ role: 'admin', count: 1 }], approvedTemplates: 0 })
  })

  it('is for our team only; an unknown company is not found', async () => {
    expect((await usageOf(a.tenantId, undefined, who.laura)).statusCode).toBe(403)
    expect((await usageOf(randomUUID())).statusCode).toBe(404)
    expect((await usageOf(a.tenantId, 'from=2026-11-30&to=2026-11-01')).statusCode).toBe(400)
  })
})

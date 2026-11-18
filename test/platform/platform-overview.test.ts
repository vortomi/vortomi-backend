// «Uso y salud» of the console (mockup web-26): every company's messages by day and by who wrote
// them, what Meta delivered, the agent's use and the platform's health, from what is stored.
// Days are Venezuela's: 23:30 on Oct 31 in Caracas is still October.
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentSettings, agentUsage, channelAccounts, contacts, conversations, messageStatusEvents, messages, webhookEvents } from '../../src/db/schema/index.ts'
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

type Author = 'customer' | 'bot' | 'staff' | 'owner_app'

async function chatOf(tenant: SeededTenant): Promise<string> {
  return withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    const [contact] = await tx.insert(contacts).values({ tenantId, channelAccountId: tenant.channelAccountId, waId: '584120000001' }).returning()
    const [conversation] = await tx.insert(conversations).values({ tenantId, contactId: contact!.id, lastActivityAt: new Date() }).returning()
    return conversation!.id
  })
}

/** A message at `at`; an outbound one may carry Meta's statuses or a send error. */
async function message(tenant: SeededTenant, conversationId: string, author: Author, at: Date, statuses: ('sent' | 'delivered' | 'read' | 'failed')[] = [], sendError: string | null = null) {
  const waMessageId = sendError ? null : `wamid.${randomUUID()}`
  await withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    await tx.insert(messages).values({
      tenantId, conversationId, waMessageId, direction: author === 'customer' ? 'in' : 'out', author,
      authorUserId: author === 'staff' ? who.laura : null, type: 'text', body: 'x', createdAt: at, sendError,
    })
    for (const status of statuses) {
      await tx.insert(messageStatusEvents).values({ tenantId, waMessageId: waMessageId!, status, occurredAt: at, pricingCategory: 'service' })
    }
  })
}

const day = (iso: string) => new Date(iso)

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })

  const chatA = await chatOf(a)
  const chatB = await chatOf(b)
  await message(a, chatA, 'customer', day('2026-11-01T03:30:00Z')) // Oct 31 in Caracas
  await message(a, chatA, 'customer', day('2026-11-03T14:00:00Z'))
  await message(a, chatA, 'bot', day('2026-11-03T14:01:00Z'), ['sent', 'delivered', 'read'])
  await message(a, chatA, 'staff', day('2026-11-03T15:00:00Z'), ['sent', 'failed'])
  await message(a, chatA, 'staff', day('2026-11-03T15:05:00Z'), [], 'Meta rejected it')
  await message(a, chatA, 'owner_app', day('2026-11-04T12:00:00Z'))
  await message(b, chatB, 'customer', day('2026-11-04T13:00:00Z'))
  await t.db.insert(agentUsage).values([
    { tenantId: a.tenantId, month: '2026-11-01', replies: 19, inputTokens: 94_794, outputTokens: 1_444 },
    { tenantId: a.tenantId, month: '2026-10-01', replies: 16, inputTokens: 53_859, outputTokens: 1_689 },
  ])
  await t.db.insert(agentSettings).values({ tenantId: a.tenantId, enabled: true })
  await t.db.insert(webhookEvents).values({ payload: {}, attempts: 1 })
  await t.db.update(channelAccounts).set({ status: 'disconnected' }).where(eq(channelAccounts.id, b.channelAccountId))

  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const overview = async (query: string, userId = who.yornel) =>
  app.inject({ method: 'GET', url: `/api/platform/usage/overview?${query}`, headers: await bearer(userId, { aal: 'aal2' }) })

describe('platform usage overview', () => {
  it('counts each company\'s messages by Caracas day and by who wrote them', async () => {
    const body = (await overview('from=2026-11-01&to=2026-11-30')).json<{ days: unknown[] }>()
    expect(body.days).toEqual([
      { date: '2026-11-03', tenantId: a.tenantId, fromCustomers: 1, automatic: 1, staff: 2, ownerApp: 0 },
      { date: '2026-11-04', tenantId: a.tenantId, fromCustomers: 0, automatic: 0, staff: 0, ownerApp: 1 },
      { date: '2026-11-04', tenantId: b.tenantId, fromCustomers: 1, automatic: 0, staff: 0, ownerApp: 0 },
    ].sort((x, y) => (x.date + x.tenantId).localeCompare(y.date + y.tenantId)))
    // The message of 23:30 on Oct 31 in Caracas belongs to October.
    const october = (await overview('from=2026-10-31&to=2026-10-31')).json<{ days: { fromCustomers: number }[] }>()
    expect(october.days).toEqual([{ date: '2026-10-31', tenantId: a.tenantId, fromCustomers: 1, automatic: 0, staff: 0, ownerApp: 0 }])
  })

  it('says what Meta delivered, and counts as failed both a refusal and a message that never reached Meta', async () => {
    const body = (await overview('from=2026-11-01&to=2026-11-30')).json<{ delivery: unknown[] }>()
    expect(body.delivery).toEqual([{ tenantId: a.tenantId, outbound: 3, delivered: 1, failed: 2 }])
  })

  it('gives the agent\'s use of the months in the range', async () => {
    expect((await overview('from=2026-11-01&to=2026-11-30')).json<{ agent: unknown[] }>().agent).toEqual([
      { tenantId: a.tenantId, replies: 19, inputTokens: 94_794, outputTokens: 1_444 },
    ])
    expect((await overview('from=2026-10-20&to=2026-11-05')).json<{ agent: { replies: number }[] }>().agent[0]!.replies).toBe(35)
  })

  it('reports the platform\'s health now: waiting webhooks, numbers by state, active companies', async () => {
    const { health } = (await overview('from=2026-11-01&to=2026-11-30')).json<{ health: Record<string, unknown> }>()
    expect(health).toMatchObject({
      webhooks: { pending: 1, retrying: 1 },
      numbers: { connected: 1, disconnected: 1, restricted: 0 },
      agentCompanies: 1,
      companies: { active: 2, numbers: 2 },
    })
  })

  it('is for our team only, and takes a sane range', async () => {
    expect((await overview('from=2026-11-01&to=2026-11-30', who.laura)).statusCode).toBe(403)
    expect((await overview('from=2026-11-30&to=2026-11-01')).statusCode).toBe(400)
    expect((await overview('from=2026-01-01&to=2026-11-30')).statusCode).toBe(400)
  })
})

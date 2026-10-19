// Monthly Meta usage per number, from stored messages and the pricing Meta reports.
// The month is the company's (Caracas): 23:30 on Oct 31 there is still October.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, messages } from '../../src/db/schema/index.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', yornel: '' }

/** A conversation whose first customer message is dated `at` (messages are never rewritten). */
async function inbound(tenant: SeededTenant, at: Date): Promise<string> {
  return withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    const [contact] = await tx.insert(contacts).values({ tenantId, channelAccountId: tenant.channelAccountId, waId: '584120000001', lastInboundAt: at }).returning()
    const [conversation] = await tx.insert(conversations).values({ tenantId, contactId: contact!.id, lastActivityAt: at }).returning()
    await tx.insert(messages).values({ tenantId, conversationId: conversation!.id, waMessageId: `wamid.${randomUUID()}`, direction: 'in', author: 'customer', type: 'text', body: 'Hola', createdAt: at })
    return conversation!.id
  })
}

/** An outbound message Meta reported as sent, with its pricing category. */
async function outbound(tenant: SeededTenant, conversationId: string, at: Date, category: string, userId: string): Promise<void> {
  const waMessageId = `wamid.${randomUUID()}`
  await withTenant(t.db, tenant.tenantId, async (scope) => {
    await scope.tx.insert(messages).values({ tenantId: tenant.tenantId, conversationId, waMessageId, direction: 'out', author: 'staff', authorUserId: userId, type: 'text', body: 'ok', createdAt: at })
    await new MessageStatusService().record(scope, {
      kind: 'status_update',
      phoneNumberId: tenant.phoneNumberId,
      waMessageId,
      timestamp: at,
      status: 'sent',
      pricing: { billable: category !== 'referral_conversion', category },
      errorText: null,
    })
  })
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.laura, { role: 'admin' })

  const october = new Date('2026-10-15T15:00:00Z')
  const lastNightOfOctoberInCaracas = new Date('2026-11-01T03:30:00Z')
  const november = new Date('2026-11-02T15:00:00Z')
  const chat = await inbound(a, october)
  await outbound(a, chat, october, 'service', who.laura)
  await outbound(a, chat, october, 'utility', who.laura)
  await outbound(a, chat, lastNightOfOctoberInCaracas, 'referral_conversion', who.laura)
  await outbound(a, chat, november, 'marketing', who.laura)
  await inbound(b, october)

  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('usage', () => {
  it('counts each number month by category, in the company time zone', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/usage?month=2026-10`, headers: await bearer(who.laura) })
    expect(response.json()).toEqual({
      items: [
        {
          tenantId: a.tenantId,
          channelAccountId: a.channelAccountId,
          month: '2026-10',
          totalMessages: 4,
          serviceMessages: 1,
          utilityMessages: 1,
          marketingMessages: 0,
          authenticationMessages: 0,
          freeEntryMessages: 1,
        },
      ],
    })
  })

  it('is for admins, and each company sees only itself', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/usage?month=2026-10`, headers: await bearer(who.carlos) })).json()).toEqual({
      error: 'admin_required',
    })
    const ofB = (await app.inject({ method: 'GET', url: `/api/tenants/${b.tenantId}/usage?month=2026-10`, headers: await bearer(who.laura) })).json<{ items: { tenantId: string }[] }>()
    expect(ofB.items.map((row) => row.tenantId)).toEqual([b.tenantId])
  })

  it('the platform console gets every company counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/platform/usage?month=2026-10', headers: await bearer(who.yornel, { aal: 'aal2' }) })
    expect(response.json<{ items: { tenantId: string }[] }>().items.map((row) => row.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort())
  })

  it('rejects a malformed month', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/usage?month=2026-13`, headers: await bearer(who.laura) })).statusCode).toBe(400)
  })
})

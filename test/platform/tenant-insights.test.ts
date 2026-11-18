// The console's figures about each company (mockup web-25): activity by day, inbox, customers,
// orders, agent, setup and who to call. Counts and dates only, and only for our team with the
// second factor.
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentSettings, agentUsage, invitations, messages, paymentMethods } from '../../src/db/schema/index.ts'
import { monthOf } from '../../src/modules/agent/sales-agent.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedAssignees, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let app: FastifyInstance
const who = { yornel: '', laura: '' }
const DAY = 24 * 60 * 60_000
let conversationOfAna = ''

const inbound = (waMessageId: string, from: string): InboundMessageEvent => ({
  kind: 'inbound_message', phoneNumberId: a.phoneNumberId, waMessageId, timestamp: new Date(), from, profileName: 'Cliente', type: 'text', body: 'hola', replyId: null, waMediaId: null,
})
const receive = async (waMessageId: string, from: string) =>
  (await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, inbound(waMessageId, from)))).conversationId

const console_ = async (path: string, aal: 'aal1' | 'aal2' = 'aal2', userId = who.yornel) =>
  app.inject({ method: 'GET', url: `/api/platform${path}`, headers: await bearer(userId, { aal }) })

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })

  // Company A: two customers today, one message of its own eight days ago, one order-less inbox.
  conversationOfAna = await receive('w-1', '584125550001')
  await receive('w-2', '584125550001')
  const second = await receive('w-3', '584125550002')
  await seedAssignees(t.db, a.tenantId, second, who.laura)
  await t.db.insert(messages).values({ tenantId: a.tenantId, conversationId: conversationOfAna, waMessageId: 'w-old', direction: 'out', author: 'staff', authorUserId: who.laura, type: 'text', body: 'listo', createdAt: new Date(Date.now() - 8 * DAY) })

  await t.db.insert(agentSettings).values({ tenantId: a.tenantId, enabled: true, businessInfo: 'Repuestos para carros' })
  await t.db.insert(agentUsage).values({ tenantId: a.tenantId, month: monthOf(new Date()), replies: 640 })
  await t.db.insert(paymentMethods).values({ tenantId: a.tenantId, type: 'pago_movil', name: 'Pago móvil' })
  await t.db.insert(invitations).values({
    tenantId: a.tenantId, email: 'pedro@example.com', name: 'Pedro', role: 'agent', tokenHash: randomBytes(16).toString('hex'),
    expiresAt: new Date(Date.now() + 3 * DAY), invitedBy: who.laura,
  })
  app = await buildTestApp(t.db, {})
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('the list of companies', () => {
  it('each company: messages of the last 14 days, last activity, agent, setup and open invitations', async () => {
    const response = await console_('/tenants/insights')
    expect(response.statusCode).toBe(200)
    const body = response.json<{ items: { tenantId: string; daily: number[]; lastActivityAt: string | null; agentEnabled: boolean; agentReplies: number; setupDone: number; pendingInvitations: number }[]; monthMessages: number; agentRepliesMonth: number; setupTotal: number }>()
    const ofA = body.items.find((i) => i.tenantId === a.tenantId)!
    expect(ofA.daily).toHaveLength(14)
    expect(ofA.daily.at(-1)).toBe(3)
    expect(ofA.daily.at(-9)).toBe(1)
    expect(ofA).toMatchObject({ agentEnabled: true, agentReplies: 640, pendingInvitations: 1 })
    // Number connected, business information, a payment method and the agent: 4 of 6.
    expect(ofA.setupDone).toBe(4)
    expect(Date.parse(ofA.lastActivityAt!)).toBeGreaterThan(Date.now() - 60_000)

    const ofB = body.items.find((i) => i.tenantId === b.tenantId)!
    expect(ofB).toMatchObject({ daily: Array(14).fill(0), lastActivityAt: null, agentEnabled: false, agentReplies: 0, setupDone: 1, pendingInvitations: 0 })
    expect(body).toMatchObject({ agentRepliesMonth: 640, setupTotal: 6 })
  })
})

describe('the page of a company', () => {
  it('30 days split by who wrote, its inbox, customers, agent against its cap, numbers and who to call', async () => {
    const detail = (await console_(`/tenants/${a.tenantId}/insights`)).json<Record<string, unknown> & { daily: { fromCustomers: number; fromCompany: number }[] }>()
    expect(detail.daily).toHaveLength(30)
    expect(detail.daily.at(-1)).toMatchObject({ fromCustomers: 3, fromCompany: 0 })
    expect(detail.daily.at(-9)).toMatchObject({ fromCustomers: 0, fromCompany: 1 })
    expect(detail).toMatchObject({
      messages30d: 4,
      previous30d: 0,
      openConversations: 2,
      unassignedOpen: 1,
      contacts: 2,
      contactsThisMonth: 2,
      ordersThisMonth: 0,
      ordersAwaitingPayment: 0,
      agent: { enabled: true, replies: 640, cap: 1000 },
      lastActivity: { fromCustomer: true },
      owner: { name: 'Laura' },
    })
    expect(detail['channels']).toMatchObject([{ channelId: a.channelAccountId, messages30d: 4, coexistence: false }])
    expect(detail['setup']).toEqual([
      { step: 'number', done: true, count: null },
      { step: 'business_info', done: true, count: null },
      { step: 'products', done: false, count: 0 },
      { step: 'payment_methods', done: true, count: 1 },
      { step: 'template', done: false, count: 0 },
      { step: 'agent', done: true, count: null },
    ])
  })

  it('an unknown company answers «not found»', async () => {
    expect((await console_('/tenants/00000000-0000-4000-8000-000000000000/insights')).json()).toEqual({ error: 'tenant_not_found' })
  })
})

describe('who may see it', () => {
  it('only our team, and only with the second factor', async () => {
    expect((await console_('/tenants/insights', 'aal1')).json()).toEqual({ error: 'second_factor_required' })
    expect((await console_(`/tenants/${a.tenantId}/insights`, 'aal2', who.laura)).json()).toEqual({ error: 'platform_admin_required' })
  })
})

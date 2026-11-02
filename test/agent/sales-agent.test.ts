// The sales agent: answers by itself while its company keeps it on, only with that conversation and
// that company's catalog; stays quiet where a person is in charge; passes the chat to a person when
// the customer wants to buy or when something fails; answers each message once. The model is a fake:
// these tests check our rules, not Google's model.
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { agentSettings, agentUsage, conversations, exchangeRates, messages, productVariants, products, tenantSettings } from '../../src/db/schema/index.ts'
import type { ChatModel, ChatReply, ChatRequest } from '../../src/modules/agent/chat-model.ts'
import { ModelBusyError } from '../../src/modules/agent/chat-model.ts'
import { SalesAgent, monthOf } from '../../src/modules/agent/sales-agent.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { AutoResponder } from '../../src/modules/messaging/auto-responder.ts'
import { AwayReplyService } from '../../src/modules/messaging/away-reply.ts'
import { BotDelivery } from '../../src/modules/messaging/bot-delivery.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import { FakeSender, silentLog, testCredentials } from '../helpers/app.ts'
import { seedAssignees, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

/** Plays the model: runs the tools it is told to, records what it was given, answers a fixed text. */
class FakeModel implements ChatModel {
  requests: ChatRequest[] = []
  toolCalls: { name: string; args: Record<string, unknown> }[] = []
  toolResults: unknown[] = []
  failWith: Error | null = null
  answer = 'Sí, tenemos pastillas de freno Bosch a 38,00 $.'

  async reply(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request)
    if (this.failWith) throw this.failWith
    for (const call of this.toolCalls) this.toolResults.push(await request.tools.find((tool) => tool.name === call.name)!.run(call.args))
    return { text: this.answer, usage: { inputTokens: 900, outputTokens: 60 } }
  }
}

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let sender: FakeSender
let model: FakeModel
let credentials: ChannelCredentials
let counter = 0
const NOW = new Date('2026-10-27T14:00:00Z')
const who = { laura: '', carlos: '' }
const ingest = new IngestService()

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await t.db.insert(tenantSettings).values({ tenantId: a.tenantId, awayMessage: 'Ya cerramos.' })
  await t.db.insert(agentSettings).values({ tenantId: a.tenantId, enabled: true, assistantName: 'Ana', businessInfo: 'Estamos en Av. Bolívar, Valencia. Pago Móvil y Zelle.' })
  await t.db.insert(agentSettings).values({ tenantId: b.tenantId, enabled: false })
  // The same product name in both companies: the agent of A must only ever see A's.
  for (const [tenant, price] of [[a, 3800], [b, 9999]] as const) {
    const [product] = await t.db.insert(products).values({ tenantId: tenant.tenantId, name: 'Pastillas de freno', stockMode: 'availability' }).returning({ id: products.id })
    await t.db.insert(productVariants).values({ tenantId: tenant.tenantId, productId: product!.id, name: 'Bosch', sku: `FRN-${price}`, priceCents: price })
  }
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAG-token-a')
})
afterAll(async () => {
  await t.close()
})
beforeEach(() => {
  sender = new FakeSender()
  model = new FakeModel()
})

const agentWith = (chat: ChatModel | null, cap = 1000) =>
  new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), chat, { monthlyCap: cap, debounceMs: 60_000, log: silentLog, now: () => NOW })

/** A customer of company A writes; returns its conversation and message id. */
async function customerWrites(from: string, body = '¿Tienen pastillas de freno?') {
  const waMessageId = `wamid.agent.${++counter}`
  const event: InboundMessageEvent = { kind: 'inbound_message', phoneNumberId: a.phoneNumberId, waMessageId, timestamp: NOW, from, profileName: 'Cliente', type: 'text', body, replyId: null, waMediaId: null }
  const record = await withTenant(t.db, a.tenantId, (scope) => ingest.recordInbound(scope, a.channelAccountId, event))
  return { conversationId: record.conversationId, waMessageId }
}

const botMessages = (conversationId: string) =>
  withTenant(t.db, a.tenantId, ({ tx }) =>
    tx.select({ body: messages.body }).from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.author, 'bot'))),
  )

const handoff = async (conversationId: string) =>
  (await withTenant(t.db, a.tenantId, ({ tx }) => tx.select({ reason: conversations.handoffReason }).from(conversations).where(eq(conversations.id, conversationId))))[0]?.reason

describe('who answers', () => {
  it('the agent takes the message while its company keeps it on; the away message does not answer too', async () => {
    const { conversationId, waMessageId } = await customerWrites('584121000001')
    const agent = agentWith(model)
    const away = new AwayReplyService(t.db, new BotDelivery(t.db, credentials, sender), silentLog, () => NOW)
    await new AutoResponder(agent, away, silentLog).afterInbound(a.tenantId, { conversationId, waMessageId, timestamp: NOW })
    // Taken (it answers after the pause), and nothing else was sent meanwhile.
    expect(await botMessages(conversationId)).toEqual([])
    expect(await agent.takes(b.tenantId, { conversationId, waMessageId, timestamp: NOW })).toBe(false)
  })

  it('without a configured model the agent is off everywhere', async () => {
    const { conversationId, waMessageId } = await customerWrites('584121000002')
    expect(await agentWith(null).takes(a.tenantId, { conversationId, waMessageId, timestamp: NOW })).toBe(false)
  })
})

describe('answering', () => {
  it('answers through the number, keeps it in the chat as the bot, counts it, and only once', async () => {
    const { conversationId } = await customerWrites('584121000003')
    const agent = agentWith(model)
    await agent.answer(a.tenantId, conversationId)
    await agent.answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([{ body: model.answer }])
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({ to: '584121000003', body: model.answer })
    const [usage] = await withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(agentUsage).where(eq(agentUsage.month, monthOf(NOW))))
    expect(usage).toMatchObject({ replies: 1, inputTokens: 900, outputTokens: 60 })
  })

  it('knows only this conversation and its company: the catalog search never shows another company', async () => {
    await customerWrites('584121000004', 'Hola')
    const { conversationId } = await customerWrites('584121000005', '¿Precio de las pastillas de freno?')
    model.toolCalls = [{ name: 'search_products', args: { query: 'pastillas freno' } }]
    await agentWith(model).answer(a.tenantId, conversationId)
    const [request] = model.requests
    expect(request!.history).toEqual([{ from: 'customer', text: '¿Precio de las pastillas de freno?' }])
    expect(request!.system).toContain('Av. Bolívar')
    expect(JSON.stringify(model.toolResults)).toContain('"priceUsd":"38.00"')
    expect(JSON.stringify(model.toolResults)).not.toContain('99.99')
  })

  it('searches the catalog before asking, so the model can answer in one call; only this company', async () => {
    const { conversationId } = await customerWrites('584121000011', '¿Cuánto cuestan las pastillas de freno?')
    const typed: string[] = []
    const typing = { showTyping: (m: { waMessageId: string }) => Promise.resolve(void typed.push(m.waMessageId)) }
    const agent = new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender, typing), model, { monthlyCap: 1000, debounceMs: 60_000, log: silentLog, now: () => NOW })
    await agent.answer(a.tenantId, conversationId)
    const system = model.requests[0]!.system
    expect(system).toContain('already searched for you')
    expect(system).toContain('"priceUsd":"38.00"')
    expect(system).not.toContain('99.99')
    // The customer saw "escribiendo…" on their message while the answer was prepared.
    expect(typed).toHaveLength(1)
  })

  it('a company with its own system answers from it, with its own rate, and not from the inventory', async () => {
    const { conversationId } = await customerWrites('584121000012', '¿Cuánto cuesta la recarga de 19 litros?')
    const own = { bsPerUsd: 888.1183, rateDate: '2026-10-28', fetchedAt: NOW, stale: false, products: [{ id: 'p1', name: 'Recarga 19L', kind: 'refill' as const, priceUsd: 0.9, priceVes: 799.31, available: true, stock: null }] }
    const catalogs = { lookup: () => Promise.resolve({ source: 'external' as const, catalog: own }) }
    await new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), model, { monthlyCap: 1000, debounceMs: 60_000, log: silentLog, now: () => NOW, catalogs }).answer(a.tenantId, conversationId)
    const system = model.requests[0]!.system
    expect(system).toContain('Recarga 19L')
    expect(system).toContain('"priceBs":"799.31"')
    expect(system).toContain('888.12 Bs per dollar')
    expect(system).not.toContain('Pastillas de freno')
  })

  it('with «Usar la tasa de mi sistema» off, its Bs prices come from the company rate in Vortomi', async () => {
    await t.db.update(tenantSettings).set({ useSystemRate: false }).where(eq(tenantSettings.tenantId, a.tenantId))
    await t.db.insert(exchangeRates).values({ tenantId: a.tenantId, rate: '900', effectiveDate: '2026-10-27', source: 'bcv' })
    try {
      const { conversationId } = await customerWrites('584121000013', '¿Cuánto cuesta la recarga de 19 litros?')
      const own = { bsPerUsd: 888.1183, rateDate: '2026-10-28', fetchedAt: NOW, stale: false, products: [{ id: 'p1', name: 'Recarga 19L', kind: 'refill' as const, priceUsd: 0.9, priceVes: 799.31, available: true, stock: null }] }
      const catalogs = { lookup: () => Promise.resolve({ source: 'external' as const, catalog: own }) }
      await new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), model, { monthlyCap: 1000, debounceMs: 60_000, log: silentLog, now: () => NOW, catalogs }).answer(a.tenantId, conversationId)
      const system = model.requests[0]!.system
      expect(system).toContain('"priceBs":"810.00"')
      expect(system).toContain('900.00 Bs per dollar')
      expect(system).not.toContain('799.31')
    } finally {
      await t.db.update(tenantSettings).set({ useSystemRate: true }).where(eq(tenantSettings.tenantId, a.tenantId))
    }
  })

  it('passes the chat to a person when the customer wants to buy, and then stays quiet', async () => {
    const { conversationId } = await customerWrites('584121000006', 'Las quiero, ¿cómo pago?')
    model.toolCalls = [{ name: 'hand_off_to_person', args: { reason: 'purchase' } }]
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await handoff(conversationId)).toBe('purchase')
    await customerWrites('584121000006', '¿Hola?')
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(model.requests).toHaveLength(1)
  })

  it('a failing model sends nothing and passes the chat to a person', async () => {
    const { conversationId } = await customerWrites('584121000007')
    model.failWith = new ModelBusyError('429 quota')
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([])
    expect(await handoff(conversationId)).toBe('agent_error')
  })

  it('past the monthly cap, the chat goes to a person without asking the model', async () => {
    const { conversationId } = await customerWrites('584121000008')
    await agentWith(model, 0).answer(a.tenantId, conversationId)
    expect(model.requests).toHaveLength(0)
    expect(await handoff(conversationId)).toBe('limit_reached')
  })
})

describe('staying quiet where a person is in charge', () => {
  it('not in a conversation assigned to someone', async () => {
    const { conversationId } = await customerWrites('584121000009')
    await seedAssignees(t.db, a.tenantId, conversationId, who.carlos)
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(model.requests).toHaveLength(0)
  })

  it('not right after someone of the team wrote', async () => {
    const { conversationId } = await customerWrites('584121000010')
    await withTenant(t.db, a.tenantId, ({ tx, tenantId }) =>
      tx.insert(messages).values({ tenantId, conversationId, direction: 'out', author: 'staff', authorUserId: who.laura, type: 'text', body: 'Ya te atiendo', createdAt: NOW }),
    )
    await customerWrites('584121000010', 'Gracias')
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(model.requests).toHaveLength(0)
  })
})

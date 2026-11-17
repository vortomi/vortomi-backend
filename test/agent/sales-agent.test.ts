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
import { CATALOG_DOWN_REPLY } from '../../src/modules/agent/agent-tools.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { OwnerAppIngest } from '../../src/modules/conversations/owner-app-ingest.ts'
import { pauseAgent, returnToAgent } from '../../src/modules/conversations/agent-handoff.ts'
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

describe('never losing or doubling an answer', () => {
  it('after a moment of failure, the next customer message is answered and the hand-off lifted', async () => {
    const from = '584121000020'
    const { conversationId } = await customerWrites(from)
    model.failWith = new ModelBusyError('503 overloaded')
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await handoff(conversationId)).toBe('agent_error')
    // Nothing new from the customer: still quiet.
    model.failWith = null
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([])
    await customerWrites(from, '¿Hola? ¿Siguen ahí?')
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([{ body: model.answer }])
    expect(await handoff(conversationId)).toBeNull()
  })

  it('a message that arrives while the model thinks drops the old answer: one answer, with everything', async () => {
    const from = '584121000021'
    const { conversationId } = await customerWrites(from, 'Quiero pastillas de freno')
    let interrupted = false
    const thinking: ChatModel = {
      reply: async (request) => {
        if (!interrupted) {
          interrupted = true
          await customerWrites(from, 'y también líquido de frenos')
        }
        return model.reply(request)
      },
    }
    await agentWith(thinking).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([])
    await agentWith(thinking).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toHaveLength(1)
    expect(model.requests.at(-1)!.history.map((turn) => turn.text)).toEqual(['Quiero pastillas de freno', 'y también líquido de frenos'])
  })

  it('on shutdown, a pending answer goes out at once instead of being lost', async () => {
    const { conversationId, waMessageId } = await customerWrites('584121000022')
    const agent = agentWith(model)
    expect(await agent.takes(a.tenantId, { conversationId, waMessageId, timestamp: NOW })).toBe(true)
    expect(await botMessages(conversationId)).toEqual([])
    await agent.drain(5_000)
    expect(await botMessages(conversationId)).toEqual([{ body: model.answer }])
  })

  it('after a restart, the messages left unanswered in the last minutes are answered', async () => {
    const { conversationId } = await customerWrites('584121000023')
    const restarted = agentWith(model)
    expect(await restarted.resumePending()).toBeGreaterThan(0)
    await restarted.drain(5_000)
    expect(await botMessages(conversationId)).toEqual([{ body: model.answer }])
  })
})

describe('when the company\'s own product system cannot be read', () => {
  const down = (chat: ChatModel) =>
    new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), chat, {
      monthlyCap: 1000,
      debounceMs: 60_000,
      log: silentLog,
      now: () => NOW,
      catalogs: { lookup: () => Promise.resolve({ source: 'external' as const, catalog: null }) },
    })

  it('a product question gets the same short line, written by the server, and goes to a person marked as such', async () => {
    const { conversationId } = await customerWrites('584125559001', '¿A cómo está la recarga de 19?')
    model.toolCalls = [{ name: 'search_products', args: { query: 'recarga 19' } }]
    model.answer = 'Uy, no puedo ver los precios porque el sistema está caído.'
    await down(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([{ body: CATALOG_DOWN_REPLY }])
    expect(await handoff(conversationId)).toBe('catalog_unavailable')
  })

  it('the model may also pass it straight away with that reason', async () => {
    const { conversationId } = await customerWrites('584125559002', 'Quiero 2 recargas de 12')
    model.toolCalls = [{ name: 'hand_off_to_person', args: { reason: 'catalog_unavailable' } }]
    await down(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([{ body: CATALOG_DOWN_REPLY }])
    expect(await handoff(conversationId)).toBe('catalog_unavailable')
  })

  it('a greeting is answered as a greeting: nothing about the failure, nobody called', async () => {
    const { conversationId } = await customerWrites('584125559003', 'Hola buenos días')
    model.answer = '¡Buenos días! ¿En qué te puedo ayudar?'
    await down(model).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([{ body: '¡Buenos días! ¿En qué te puedo ayudar?' }])
    expect(await handoff(conversationId)).toBeNull()
    expect(model.requests[0]!.system).toContain('For greetings and anything else, answer normally and do not mention it.')
  })

  it('with the catalog readable, the model cannot use that reason', async () => {
    const { conversationId } = await customerWrites('584125559004', '¿Tienen pastillas de freno?')
    model.toolCalls = [{ name: 'hand_off_to_person', args: { reason: 'catalog_unavailable' } }]
    await agentWith(model).answer(a.tenantId, conversationId)
    expect(await handoff(conversationId)).toBe('agent_unsure')
  })
})

describe('when the owner answers from the WhatsApp Business app (coexistence)', () => {
  const ownerApp = new OwnerAppIngest()
  const ownerWrites = (customer: string, at: Date) =>
    withTenant(t.db, a.tenantId, (scope) =>
      ownerApp.recordEcho(scope, a.channelAccountId, {
        kind: 'owner_echo',
        phoneNumberId: a.phoneNumberId,
        waMessageId: `wamid.owner.${++counter}`,
        to: customer,
        timestamp: at,
        type: 'text',
        body: 'Sí, hoy te la llevo yo mismo',
        replyId: null,
        waMediaId: null,
      }),
    )
  const agentAt = (now: Date) =>
    new SalesAgent(t.db, new BotDelivery(t.db, credentials, sender), model, { monthlyCap: 1000, debounceMs: 60_000, log: silentLog, now: () => now })
  const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)

  it('stays quiet in that conversation for 30 minutes after the owner\'s last message', async () => {
    const { conversationId } = await customerWrites('584125559101', '¿Tienen recarga de 12?')
    await ownerWrites('584125559101', minutes(-10))
    await customerWrites('584125559101', 'Perfecto, gracias')
    await agentAt(NOW).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([])
    expect(model.requests).toHaveLength(0)
  })

  it('each new message of the owner moves the pause; past it, the agent answers again by itself', async () => {
    const { conversationId } = await customerWrites('584125559102')
    await ownerWrites('584125559102', minutes(-25))
    await ownerWrites('584125559102', minutes(-5))
    await customerWrites('584125559102', 'Otra cosa, ¿tienen hielo?')
    // 25 minutes after the owner's last message: still theirs.
    await agentAt(minutes(20)).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toEqual([])
    // 31 minutes after it: the agent is back.
    await agentAt(minutes(26)).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toHaveLength(1)
  })

  it('«Devolver al agente» ends the pause at once', async () => {
    const { conversationId } = await customerWrites('584125559103')
    await ownerWrites('584125559103', minutes(-1))
    await withTenant(t.db, a.tenantId, (scope) => returnToAgent(scope, conversationId))
    await customerWrites('584125559103', '¿Y el delivery?')
    await agentAt(NOW).answer(a.tenantId, conversationId)
    expect(await botMessages(conversationId)).toHaveLength(1)
  })

  it('the away message does not answer over the owner either', async () => {
    // 3 am in Caracas, a Tuesday: closed, so the away message goes out unless the owner is answering.
    const closed = new Date('2026-10-27T07:00:00Z')
    await withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.update(tenantSettings).set({ businessHours: [{ day: 2, open: '08:00', close: '17:00' }] }).where(eq(tenantSettings.tenantId, a.tenantId)),
    )
    const away = new AwayReplyService(t.db, new BotDelivery(t.db, credentials, sender), silentLog, () => closed)
    try {
      const control = await customerWrites('584125559104', 'Hola')
      await away.afterInbound(a.tenantId, { conversationId: control.conversationId, waMessageId: control.waMessageId, timestamp: closed })
      expect(sender.sent).toHaveLength(1)

      const paused = await customerWrites('584125559105', 'Hola')
      await withTenant(t.db, a.tenantId, (scope) => pauseAgent(scope, paused.conversationId, new Date(closed.getTime() - 60_000), null))
      await away.afterInbound(a.tenantId, { conversationId: paused.conversationId, waMessageId: paused.waMessageId, timestamp: closed })
      expect(sender.sent).toHaveLength(1)
    } finally {
      await withTenant(t.db, a.tenantId, ({ tx }) => tx.update(tenantSettings).set({ businessHours: [] }).where(eq(tenantSettings.tenantId, a.tenantId)))
    }
  })
})

describe('the company\'s waiting time (Ajustes → Agente)', () => {
  it('a shorter wait brings the agent back sooner: 5 minutes after the owner, it answers', async () => {
    await t.db.update(agentSettings).set({ humanPauseMinutes: 5 }).where(eq(agentSettings.tenantId, a.tenantId))
    try {
      const { conversationId } = await customerWrites('584125559201')
      await withTenant(t.db, a.tenantId, (scope) => pauseAgent(scope, conversationId, new Date(NOW.getTime() - 10 * 60_000), null))
      await customerWrites('584125559201', '¿Y para mañana?')
      await agentWith(model).answer(a.tenantId, conversationId)
      expect(await botMessages(conversationId)).toHaveLength(1)
    } finally {
      await t.db.update(agentSettings).set({ humanPauseMinutes: 30 }).where(eq(agentSettings.tenantId, a.tenantId))
    }
  })
})

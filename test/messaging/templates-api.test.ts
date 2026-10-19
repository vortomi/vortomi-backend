// A template's life: an admin submits it, Meta's verdict arrives by webhook (routed by
// WhatsApp Business Account), and once approved it can reach a customer whose 24 h
// window has closed. Nothing of it can cross to another company.
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { channelAccounts } from '../../src/db/schema/index.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { EventRouter } from '../../src/modules/inbox/event-router.ts'
import { TemplateService } from '../../src/modules/templates/template-service.ts'
import { ChannelDirectory } from '../../src/modules/tenancy/channel-directory.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { parseWebhookPayload } from '../../src/modules/whatsapp/webhook-parser.ts'
import { FakeRegistry, FakeSender, buildTestApp, testCredentials } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { templateStatusWebhook } from '../helpers/meta-payloads.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
let sender: FakeSender
let registry: FakeRegistry
let credentials: ChannelCredentials
let router: EventRouter
let expiredChat: string
const who = { laura: '', carlos: '', pedro: '' }

const body = 'Hola {{1}}, tu pedido {{2}} salió hoy.'

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin', channelAccountIds: [b.channelAccountId] })

  // The customer wrote two days ago: free-form replies are closed, templates are not.
  const event = {
    kind: 'inbound_message' as const,
    phoneNumberId: a.phoneNumberId,
    waMessageId: `wamid.${randomUUID()}`,
    timestamp: new Date(Date.now() - 48 * 3_600_000),
    from: '584120000001',
    profileName: 'Cliente',
    type: 'text' as const,
    body: 'Hola',
    replyId: null,
    waMediaId: null,
  }
  expiredChat = (await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, event))).conversationId

  sender = new FakeSender()
  registry = new FakeRegistry()
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAG-token-a')
  router = new EventRouter(t.db, new ChannelDirectory(t.db), new IngestService(), new MessageStatusService(), new TemplateService(t.db, credentials, registry))
  app = await buildTestApp(t.db, { sender, credentials, templateRegistry: registry })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const deliverWebhook = async (payload: object) => {
  for (const event of parseWebhookPayload(payload).events) await router.handle(event)
}
const templates = async (userId = who.laura, tenantId = a.tenantId) =>
  (await call(userId, 'GET', '/templates', undefined, tenantId)).json<{ items: { id: string; name: string; status: string; rejectionReason: string | null }[] }>().items

let templateId: string

describe('submitting a template', () => {
  it('an admin submits it to Meta with its examples; it waits for review', async () => {
    const response = await call(who.laura, 'POST', '/templates', { name: 'order_shipped', category: 'utility', body, bodyExample: ['Ana', '1043'] })
    expect(response.statusCode).toBe(201)
    templateId = response.json<{ id: string }>().id
    expect(response.json()).toMatchObject({ status: 'pending', language: 'es', wabaId: a.wabaId, submitError: null })
    expect(registry.submitted).toEqual([
      expect.objectContaining({ wabaId: a.wabaId, accessToken: 'EAAG-token-a', name: 'order_shipped', category: 'utility', bodyExample: ['Ana', '1043'] }),
    ])
  })

  it('agents cannot, examples must match the parameters, names are unique', async () => {
    expect((await call(who.carlos, 'POST', '/templates', { name: 'x', category: 'utility', body: 'Hola' })).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/templates', { name: 'y', category: 'utility', body, bodyExample: ['Ana'] })).json()).toEqual({
      error: 'invalid_template',
    })
    expect((await call(who.laura, 'POST', '/templates', { name: 'order_shipped', category: 'utility', body, bodyExample: ['A', 'B'] })).json()).toEqual({
      error: 'template_exists',
    })
  })

  it('a company without credentials keeps it as a draft with the reason', async () => {
    const response = await call(who.pedro, 'POST', '/templates', { name: 'promo', category: 'marketing', body: 'Oferta' }, b.tenantId)
    expect(response.json()).toMatchObject({ status: 'draft', submitError: 'no_credentials' })
  })
})

describe("Meta's verdict", () => {
  it('a webhook for another account never touches this company templates', async () => {
    await deliverWebhook(templateStatusWebhook(b.wabaId, { event: 'APPROVED', message_template_id: 9_000_001 }))
    expect((await templates()).find((tpl) => tpl.id === templateId)?.status).toBe('pending')
  })

  it('approval arrives by webhook and is matched by Meta id', async () => {
    await deliverWebhook(templateStatusWebhook(a.wabaId, { event: 'APPROVED', message_template_id: 9_000_001, reason: 'NONE' }))
    expect((await templates(who.carlos)).find((tpl) => tpl.id === templateId)?.status).toBe('approved')
  })
})

describe('sending a template', () => {
  const send = (userId: string, payload: object) => call(userId, 'POST', `/conversations/${expiredChat}/template-messages`, payload)

  it('reaches a customer whose 24 h window closed, and the history shows the filled text', async () => {
    const free = await call(who.carlos, 'POST', `/conversations/${expiredChat}/messages`, { body: 'Hola', clientMessageId: randomUUID() })
    expect(free.json()).toEqual({ error: 'service_window_closed' })

    const response = await send(who.carlos, { templateId, parameters: ['Ana', '1043'], clientMessageId: randomUUID() })
    expect(response.json()).toMatchObject({ outcome: 'sent' })
    expect(sender.sent.at(-1)).toEqual({
      phoneNumberId: a.phoneNumberId,
      accessToken: 'EAAG-token-a',
      to: '584120000001',
      name: 'order_shipped',
      language: 'es',
      bodyParameters: ['Ana', '1043'],
    })
    const messages = (await call(who.carlos, 'GET', `/conversations/${expiredChat}/messages`)).json<{ items: { body: string }[] }>().items
    expect(messages[0]?.body).toBe('Hola Ana, tu pedido 1043 salió hoy.')
  })

  it('refuses the wrong number of parameters, an unapproved template and another company template', async () => {
    expect((await send(who.carlos, { templateId, parameters: ['Ana'], clientMessageId: randomUUID() })).json()).toEqual({ error: 'invalid_template' })
    const draft = (await templates(who.pedro, b.tenantId))[0]!
    expect((await send(who.carlos, { templateId: draft.id, parameters: [], clientMessageId: randomUUID() })).json()).toEqual({
      error: 'template_not_usable',
    })
    await deliverWebhook(templateStatusWebhook(a.wabaId, { event: 'PAUSED', message_template_id: 9_000_001 }))
    expect((await send(who.carlos, { templateId, parameters: ['Ana', '1'], clientMessageId: randomUUID() })).json()).toEqual({
      error: 'template_not_usable',
    })
  })
})

describe('one company per WhatsApp Business Account', () => {
  it('the database refuses a number of another company under the same account', async () => {
    const borrowed = t.db
      .insert(channelAccounts)
      .values({ tenantId: b.tenantId, wabaId: a.wabaId, phoneNumberId: '100000000000077', displayNumber: '+58 412-555-0177', label: 'Ajeno' })
    expect(await dbError(borrowed)).toMatch(/already belongs to another company/)
  })
})

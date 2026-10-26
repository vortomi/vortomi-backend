// The routing guarantee of the platform (design document 8.1), end to end over HTTP:
// whatever Meta sends, each message lands in the company that owns the number, and
// in no other one.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { contacts, messageDeliveryStatus, messages, webhookEvents } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { EventRouter } from '../../src/modules/inbox/event-router.ts'
import { SerialQueue } from '../../src/modules/inbox/serial-queue.ts'
import { WebhookEventRepository } from '../../src/modules/inbox/webhook-event.repository.ts'
import { WebhookInbox } from '../../src/modules/inbox/webhook-inbox.ts'
import { WebhookProcessor } from '../../src/modules/inbox/webhook-processor.ts'
import { InboxFeed } from '../../src/modules/realtime/inbox-feed.ts'
import { ChannelDirectory } from '../../src/modules/tenancy/channel-directory.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { parseWebhookPayload } from '../../src/modules/whatsapp/webhook-parser.ts'
import {
  APP_SECRET,
  CUSTOMER_WA_ID,
  PHONE_UNKNOWN,
  VERIFY_TOKEN,
  sign,
  statusChange,
  textChange,
  webhook,
} from '../helpers/meta-payloads.ts'
import { FakeRegistry, FakeWabaDirectory, FakeSender, testCredentials } from '../helpers/app.ts'
import { testVerifier } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { seedTwoTenants, type SeededTenant } from '../helpers/tenants.ts'

const silentLog = { warn: () => undefined, error: () => undefined }

let t: TestDatabase
let app: FastifyInstance
let queue: SerialQueue
let a: SeededTenant
let b: SeededTenant

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  const repository = new WebhookEventRepository(t.db)
  const router = new EventRouter(t.db, new ChannelDirectory(t.db), new IngestService(), new MessageStatusService(), { applyStatus: () => Promise.resolve() })
  const processor = new WebhookProcessor(repository, parseWebhookPayload, router, silentLog)
  queue = new SerialQueue((id) => processor.process(id), () => undefined)
  const inbox = new WebhookInbox(repository, queue, { maxAttempts: 5, sweepGraceMs: 0, sweepBatchSize: 50 })
  app = await buildApp(
    { db: t.db, verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, onVerifiedPayload: async (payload) => void (await inbox.receive(payload)), tokenVerifier: testVerifier(), credentials: testCredentials(t.db), sender: new FakeSender(), templateRegistry: new FakeRegistry(), wabaDirectory: new FakeWabaDirectory(), feed: new InboxFeed() },
    false,
  )
})

afterAll(async () => {
  await app.close()
  await t.close()
})

beforeEach(async () => {
  await queue.idle()
})

async function post(payload: object, signature?: string): Promise<number> {
  const body = JSON.stringify(payload)
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) },
    payload: body,
  })
  await queue.idle()
  return response.statusCode
}

/** What a company sees through its own scope, as the panel will. */
const seenBy = (tenant: SeededTenant) =>
  withTenant(t.db, tenant.tenantId, async ({ tx }) => ({
    messages: (await tx.select({ body: messages.body }).from(messages)).map((m) => m.body).sort(),
    contacts: (await tx.select({ waId: contacts.waId }).from(contacts)).map((c) => c.waId),
  }))

describe('two companies, zero crossings', () => {
  it('rejects a forged webhook and stores nothing', async () => {
    expect(await post(webhook(textChange(a.phoneNumberId, 'wamid.forged', 'falso')), sign('{}', 'wrong-secret'))).toBe(401)
    expect(await t.db.select().from(webhookEvents)).toEqual([])
  })

  it('puts each message in the company that owns the number', async () => {
    expect(await post(webhook(textChange(a.phoneNumberId, 'wamid.a1', 'para A')))).toBe(200)
    expect(await post(webhook(textChange(b.phoneNumberId, 'wamid.b1', 'para B')))).toBe(200)
    expect((await seenBy(a)).messages).toEqual(['para A'])
    expect((await seenBy(b)).messages).toEqual(['para B'])
  })

  it('splits one webhook that carries events of both companies', async () => {
    await post(webhook(textChange(a.phoneNumberId, 'wamid.a2', 'A en lote'), textChange(b.phoneNumberId, 'wamid.b2', 'B en lote')))
    expect((await seenBy(a)).messages).toEqual(['A en lote', 'para A'])
    expect((await seenBy(b)).messages).toEqual(['B en lote', 'para B'])
  })

  it('keeps the same customer apart when they write to both companies', async () => {
    expect((await seenBy(a)).contacts).toEqual([CUSTOMER_WA_ID])
    expect((await seenBy(b)).contacts).toEqual([CUSTOMER_WA_ID])
    const all = await t.db.select({ tenantId: contacts.tenantId }).from(contacts)
    expect(all).toHaveLength(2)
  })

  it('sets aside a number no company owns: nothing stored, nobody sees it', async () => {
    await post(webhook(textChange(PHONE_UNKNOWN, 'wamid.x', 'de nadie')))
    expect((await seenBy(a)).messages).not.toContain('de nadie')
    expect((await seenBy(b)).messages).not.toContain('de nadie')
    const [event] = (await t.db.select().from(webhookEvents)).slice(-1)
    expect(event?.processedAt).not.toBeNull()
    expect(event?.lastError).toBe(`unroutable: ${PHONE_UNKNOWN}`)
  })

  it('stores a replayed webhook once', async () => {
    await post(webhook(textChange(a.phoneNumberId, 'wamid.a1', 'para A')))
    expect((await seenBy(a)).messages).toEqual(['A en lote', 'para A'])
  })

  it('routes delivery statuses too, and a company never sees another one’s', async () => {
    await post(webhook(statusChange(a.phoneNumberId, 'wamid.out-a', 'delivered')))
    const statusOf = (tenant: SeededTenant) =>
      withTenant(t.db, tenant.tenantId, ({ tx }) => tx.select({ id: messageDeliveryStatus.waMessageId }).from(messageDeliveryStatus))
    expect(await statusOf(a)).toEqual([{ id: 'wamid.out-a' }])
    expect(await statusOf(b)).toEqual([])
  })
})

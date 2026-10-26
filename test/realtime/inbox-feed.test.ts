// Real-time inbox: every change the inbox shows is announced by the database on commit,
// reaches only the panels of its own company, carries ids and never content, and a
// rolled-back change is never announced.
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { type InboxChange, InboxFeed } from '../../src/modules/realtime/inbox-feed.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
const feed = new InboxFeed()
let stopFeed: () => Promise<void>
const heard: Record<'a' | 'b', InboxChange[]> = { a: [], b: [] }

/** PGlite delivers notices asynchronously, right after the commit. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const message = (tenant: SeededTenant, body: string, waMessageId: string) =>
  ({
    kind: 'inbound_message',
    phoneNumberId: tenant.phoneNumberId,
    waMessageId,
    timestamp: new Date(),
    from: '584125550001',
    profileName: 'Cliente',
    type: 'text',
    body,
    replyId: null,
    waMediaId: null,
  }) as const

const inbound = (tenant: SeededTenant, body = 'Hola', waMessageId = `wamid.${randomUUID()}`) =>
  withTenant(t.db, tenant.tenantId, (scope) => new IngestService().recordInbound(scope, tenant.channelAccountId, message(tenant, body, waMessageId)))

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  stopFeed = await feed.start((channel, onNotice) => t.client.listen(channel, onNotice).then((stop) => () => stop()))
  feed.subscribe(a.tenantId, (change) => heard.a.push(change))
  feed.subscribe(b.tenantId, (change) => heard.b.push(change))
})

afterAll(async () => {
  await stopFeed()
  await t.close()
})

describe('change notices', () => {
  it('a customer message reaches its own company, with the conversation and nothing of its text', async () => {
    heard.a.length = heard.b.length = 0
    const { conversationId } = await inbound(a, 'Pastillas para Corolla')
    await settle()
    expect(heard.a.length).toBeGreaterThan(0)
    expect(heard.a.every((change) => change.conversationId === conversationId)).toBe(true)
    expect(JSON.stringify(heard.a)).not.toContain('Corolla')
    expect(heard.b).toEqual([])
  })

  it('a delivery status of a known message points at its conversation', async () => {
    const waMessageId = `wamid.${randomUUID()}`
    const { conversationId } = await inbound(a, 'otra', waMessageId)
    await settle()
    heard.a.length = 0
    const status = { kind: 'status_update', phoneNumberId: a.phoneNumberId, waMessageId, timestamp: new Date(), status: 'read', pricing: null, errorText: null } as const
    await withTenant(t.db, a.tenantId, (scope) => new MessageStatusService().record(scope, status))
    await settle()
    expect(heard.a).toEqual([{ conversationId }])
  })

  it('a change that is rolled back is never announced', async () => {
    heard.a.length = 0
    await withTenant(t.db, a.tenantId, async (scope) => {
      await new IngestService().recordInbound(scope, a.channelAccountId, message(a, 'no', `wamid.${randomUUID()}`))
      throw new Error('rollback')
    }).catch(() => undefined)
    await settle()
    expect(heard.a).toEqual([])
  })
})

describe('the live stream', () => {
  let app: FastifyInstance
  let base = ''
  const laura = { id: '' }
  const pedro = { id: '' }

  beforeAll(async () => {
    laura.id = await seedUser(t.db, 'Laura')
    pedro.id = await seedUser(t.db, 'Pedro')
    await seedMembership(t.db, a.tenantId, laura.id, { role: 'admin' })
    await seedMembership(t.db, b.tenantId, pedro.id, { role: 'admin' })
    app = await buildTestApp(t.db, { feed })
    await app.listen({ host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it('refuses someone of another company before opening anything', async () => {
    const response = await fetch(`${base}/api/tenants/${a.tenantId}/events`, { headers: await bearer(pedro.id) })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'not_a_member' })
  })

  it('tells a member, at once, that a conversation of their company changed', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/tenants/${a.tenantId}/events`, { headers: await bearer(laura.id), signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const decoder = new TextDecoder()
    let received = ''
    const readUntil = async (text: string) => {
      while (!received.includes(text)) {
        const { value } = await reader.read()
        received += decoder.decode(value, { stream: true })
      }
    }
    await readUntil('event: ready')
    const { conversationId } = await inbound(a)
    await readUntil('event: change')
    expect(received).toContain(conversationId)
    controller.abort()
  })
})

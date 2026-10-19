import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, messages } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent, StatusUpdateEvent } from '../../src/modules/whatsapp/events.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { seedTwoTenants, type SeededTenant } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
const ingest = new IngestService()
const statuses = new MessageStatusService()

const inbound = (waMessageId: string, at = new Date('2026-10-13T10:00:00Z')): InboundMessageEvent => ({
  kind: 'inbound_message',
  phoneNumberId: a.phoneNumberId,
  waMessageId,
  timestamp: at,
  from: '584121111111',
  profileName: 'María',
  type: 'text',
  body: 'hola',
  replyId: null,
  waMediaId: null,
})

const status = (waMessageId: string, value: StatusUpdateEvent['status']): StatusUpdateEvent => ({
  kind: 'status_update',
  phoneNumberId: a.phoneNumberId,
  waMessageId,
  timestamp: new Date(),
  status: value,
  pricing: null,
  errorText: null,
})

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
})
afterAll(async () => {
  await t.close()
})

describe('IngestService', () => {
  it('stores a message once, however many times Meta delivers it', async () => {
    const first = await withTenant(t.db, a.tenantId, (scope) => ingest.recordInbound(scope, a.channelAccountId, inbound('wamid.dup')))
    const again = await withTenant(t.db, a.tenantId, (scope) => ingest.recordInbound(scope, a.channelAccountId, inbound('wamid.dup')))
    expect(first.isNew).toBe(true)
    expect(again).toEqual({ ...first, isNew: false })
    const stored = await withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(messages))
    expect(stored.filter((m) => m.waMessageId === 'wamid.dup')).toHaveLength(1)
  })

  it('keeps one contact and one conversation per customer, and reopens it on a new message', async () => {
    const { conversationId } = await withTenant(t.db, a.tenantId, (scope) =>
      ingest.recordInbound(scope, a.channelAccountId, inbound('wamid.next', new Date('2026-10-13T11:00:00Z'))),
    )
    const state = await withTenant(t.db, a.tenantId, async ({ tx }) => ({
      contacts: await tx.select().from(contacts),
      conversations: await tx.select().from(conversations),
    }))
    expect(state.contacts).toHaveLength(1)
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0]).toMatchObject({ id: conversationId, status: 'open' })
    expect(state.conversations[0]?.lastActivityAt.toISOString()).toBe('2026-10-13T11:00:00.000Z')
  })
})

describe('MessageStatusService', () => {
  it('derives the furthest status, whatever order Meta sends them in', async () => {
    const outcome = await withTenant(t.db, a.tenantId, async (scope) => [
      await statuses.record(scope, status('wamid.out', 'read')),
      await statuses.record(scope, status('wamid.out', 'sent')),
      await statuses.record(scope, status('wamid.out', 'delivered')),
      await statuses.record(scope, status('wamid.out', 'read')),
    ])
    expect(outcome).toEqual(['recorded', 'recorded', 'recorded', 'duplicate'])
    expect(await withTenant(t.db, a.tenantId, (scope) => statuses.current(scope, 'wamid.out'))).toBe('read')
  })

  it('reports nothing for a message Meta has not reported on', async () => {
    expect(await withTenant(t.db, a.tenantId, (scope) => statuses.current(scope, 'wamid.unknown'))).toBeNull()
  })
})

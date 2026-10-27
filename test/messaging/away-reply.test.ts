// The away message: sent by itself when a customer writes while the company is closed (its
// schedule, its time zone), once per conversation in 12 hours, never on top of a person who is
// attending, never for a message recovered late, and never twice for the same webhook.
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type BusinessDay, messages, tenantSettings } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { AwayReplyService } from '../../src/modules/messaging/away-reply.ts'
import { isOpenAt } from '../../src/modules/messaging/business-hours.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { FakeSender, silentLog, testCredentials } from '../helpers/app.ts'
import { seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

// Monday to Friday 08:00-17:00 in Caracas (UTC-4); Saturday and Sunday closed.
const WEEKDAYS: BusinessDay[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day: day as BusinessDay['day'],
  open: day >= 1 && day <= 5 ? '08:00' : null,
  close: day >= 1 && day <= 5 ? '17:00' : null,
}))
const AWAY = 'Ya cerramos. Te respondemos mañana desde las 8 am.'
// Tuesday 27/10/2026: 22:00 in Caracas (closed) and 10:00 (open).
const CLOSED_AT = new Date('2026-10-28T02:00:00Z')
const OPEN_AT = new Date('2026-10-27T14:00:00Z')

describe('isOpenAt', () => {
  it('reads the schedule on the company clock', () => {
    expect(isOpenAt(WEEKDAYS, OPEN_AT, 'America/Caracas')).toBe(true)
    // 22:00 Tuesday in Caracas is already Wednesday in UTC: the company's day counts.
    expect(isOpenAt(WEEKDAYS, CLOSED_AT, 'America/Caracas')).toBe(false)
    expect(isOpenAt(WEEKDAYS, new Date('2026-10-27T21:00:00Z'), 'America/Caracas')).toBe(false)
    expect(isOpenAt(WEEKDAYS, new Date('2026-10-31T14:00:00Z'), 'America/Caracas')).toBe(false)
  })

  it('a company without a schedule is always open', () => {
    expect(isOpenAt([], CLOSED_AT, 'America/Caracas')).toBe(true)
  })
})

let t: TestDatabase
let a: SeededTenant
let sender: FakeSender
let clock: Date
let counter = 0
let credentials: ChannelCredentials
const who = { laura: '' }
const ingest = new IngestService()

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  await t.db.insert(tenantSettings).values({ tenantId: a.tenantId, businessHours: WEEKDAYS, awayMessage: AWAY })
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAG-token-a')
})
afterAll(async () => {
  await t.close()
})
beforeEach(() => {
  sender = new FakeSender()
})

/** A customer writes at `at`; the service runs a moment later, as the webhook pipeline does. */
async function customerWrites(from: string, at: Date, waMessageId = `wamid.in.${++counter}`) {
  const event: InboundMessageEvent = {
    kind: 'inbound_message',
    phoneNumberId: a.phoneNumberId,
    waMessageId,
    timestamp: at,
    from,
    profileName: 'Cliente',
    type: 'text',
    body: 'Hola, ¿tienen?',
    replyId: null,
    waMediaId: null,
  }
  const record = await withTenant(t.db, a.tenantId, (scope) => ingest.recordInbound(scope, a.channelAccountId, event))
  clock = new Date(at.getTime() + 2_000)
  const service = new AwayReplyService(t.db, credentials, sender, silentLog, () => clock)
  await service.afterInbound(a.tenantId, { conversationId: record.conversationId, waMessageId, timestamp: at })
  return { ...record, service, waMessageId }
}

const botMessages = (conversationId: string) =>
  withTenant(t.db, a.tenantId, ({ tx }) =>
    tx
      .select({ body: messages.body, sendError: messages.sendError })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.author, 'bot'))),
  )

describe('AwayReplyService', () => {
  it('answers a customer who writes while closed, through their number, and keeps it in the chat', async () => {
    const { conversationId } = await customerWrites('584121000001', CLOSED_AT)
    expect(sender.sent).toEqual([{ phoneNumberId: a.phoneNumberId, accessToken: 'EAAG-token-a', to: '584121000001', body: AWAY }])
    expect(await botMessages(conversationId)).toEqual([{ body: AWAY, sendError: null }])
  })

  it('stays quiet while the company is open', async () => {
    const { conversationId } = await customerWrites('584121000002', OPEN_AT)
    expect(await botMessages(conversationId)).toEqual([])
  })

  it('once per conversation in 12 hours, however many messages the customer sends', async () => {
    const first = await customerWrites('584121000003', CLOSED_AT)
    await customerWrites('584121000003', new Date(CLOSED_AT.getTime() + 60_000))
    expect(await botMessages(first.conversationId)).toHaveLength(1)
  })

  it('the same webhook processed twice answers once', async () => {
    const first = await customerWrites('584121000004', CLOSED_AT)
    await first.service.afterInbound(a.tenantId, { conversationId: first.conversationId, waMessageId: first.waMessageId, timestamp: CLOSED_AT })
    expect(await botMessages(first.conversationId)).toHaveLength(1)
  })

  it('not on top of someone of the team who answered within the hour', async () => {
    const first = await customerWrites('584121000005', OPEN_AT)
    await t.db.insert(messages).values({
      tenantId: a.tenantId,
      conversationId: first.conversationId,
      direction: 'out',
      author: 'staff',
      authorUserId: who.laura,
      type: 'text',
      body: 'Ya te ayudo',
      createdAt: new Date(CLOSED_AT.getTime() - 30 * 60_000),
    })
    await customerWrites('584121000005', CLOSED_AT)
    expect(await botMessages(first.conversationId)).toEqual([])
  })

  it('a message recovered long after it was written gets no answer', async () => {
    const { conversationId } = await customerWrites('584121000006', CLOSED_AT)
    const late = new AwayReplyService(t.db, credentials, sender, silentLog, () => new Date(CLOSED_AT.getTime() + 60 * 60_000))
    await late.afterInbound(a.tenantId, { conversationId, waMessageId: 'wamid.late', timestamp: CLOSED_AT })
    expect(await botMessages(conversationId)).toHaveLength(1)
  })
})

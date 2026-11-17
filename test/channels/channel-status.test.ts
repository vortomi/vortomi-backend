// Fase 5: Meta tells us when a company's WhatsApp account stops working for us (account_update): the
// owner disconnected it from the WhatsApp Business app, Meta disabled or restricted it, it was
// deleted. Its numbers say so (status and why), the bot stops answering through a disconnected one,
// and «Conectar con WhatsApp» brings it back.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { channelAccounts, conversations } from '../../src/db/schema/index.ts'
import { ChannelStatusService, statusChangeFor } from '../../src/modules/channels/channel-status.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { EventRouter } from '../../src/modules/inbox/event-router.ts'
import { findTarget } from '../../src/modules/messaging/bot-delivery.ts'
import { ChannelDirectory } from '../../src/modules/tenancy/channel-directory.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { AccountUpdateEvent } from '../../src/modules/whatsapp/events.ts'
import { parseWebhookPayload } from '../../src/modules/whatsapp/webhook-parser.ts'
import { CUSTOMER_WA_ID, textChange, webhook } from '../helpers/meta-payloads.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let router: EventRouter

/** account_update as Meta sends it: entry.id is the account; waba_info names it in partner events. */
const accountUpdate = (wabaId: string, value: object) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, time: 1790000000, changes: [{ field: 'account_update', value }] }],
})

const removedByOwner = (wabaId: string) =>
  accountUpdate(wabaId, {
    event: 'PARTNER_REMOVED',
    waba_info: { waba_id: wabaId, owner_business_id: '1' },
    disconnection_info: { reason: 'ACCOUNT_DISCONNECTED', initiated_by: 'USER' },
  })

async function deliver(payload: object) {
  const { events, skipped } = parseWebhookPayload(payload)
  const outcomes = []
  for (const event of events) outcomes.push(await router.handle(event))
  return { outcomes, skipped }
}

const channelOf = async (tenant: SeededTenant) =>
  (
    await t.db
      .select({ status: channelAccounts.status, reason: channelAccounts.statusReason, at: channelAccounts.statusChangedAt })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, tenant.channelAccountId))
  )[0]!

const event = (over: Partial<AccountUpdateEvent>): AccountUpdateEvent => ({
  kind: 'account_update',
  wabaId: '1',
  event: 'X',
  disconnection: null,
  banState: null,
  restrictions: null,
  ...over,
})

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  router = new EventRouter(t.db, new ChannelDirectory(t.db), new IngestService(), new MessageStatusService(), { applyStatus: () => Promise.resolve() })
})
afterAll(async () => {
  await t.close()
})
beforeEach(async () => {
  await t.db.update(channelAccounts).set({ status: 'connected', statusReason: null, statusChangedAt: null })
})

describe('the owner disconnects Vortomi from the WhatsApp Business app', () => {
  it('marks the numbers of that account disconnected by the owner, only in its company', async () => {
    expect((await deliver(removedByOwner(a.wabaId))).outcomes).toEqual(['handled'])
    expect(await channelOf(a)).toMatchObject({ status: 'disconnected', reason: 'owner_disconnected' })
    expect((await channelOf(a)).at).toBeInstanceOf(Date)
    expect(await channelOf(b)).toMatchObject({ status: 'connected', reason: null })
  })

  it('the bot no longer answers through it; the team still reaches the conversation', async () => {
    const { events } = parseWebhookPayload(webhook(textChange(a.phoneNumberId, 'wamid.status.1', 'Hola')))
    await router.handle(events[0]!)
    await deliver(removedByOwner(a.wabaId))
    const conversationId = await withTenant(t.db, a.tenantId, async ({ tx }) => (await tx.select({ id: conversations.id }).from(conversations))[0]!.id)
    expect(await withTenant(t.db, a.tenantId, ({ tx }) => findTarget(tx, a.tenantId, conversationId, true))).toBeNull()
    expect(await withTenant(t.db, a.tenantId, ({ tx }) => findTarget(tx, a.tenantId, conversationId))).toMatchObject({ to: CUSTOMER_WA_ID })
  })

  it('a repeated webhook keeps the date of the first one', async () => {
    await deliver(removedByOwner(a.wabaId))
    const first = (await channelOf(a)).at
    await deliver(removedByOwner(a.wabaId))
    expect((await channelOf(a)).at).toEqual(first)
  })

  it('an account no company owns is set aside', async () => {
    expect((await deliver(removedByOwner('299999999999999'))).outcomes).toEqual(['unroutable'])
  })
})

describe('what each event means', () => {
  it('reads why Meta cut a coexistence number', () => {
    const removed = (reason: string, initiatedBy = 'SYSTEM') => statusChangeFor(event({ event: 'PARTNER_REMOVED', disconnection: { reason, initiatedBy } }))?.reason
    expect(removed('ACCOUNT_DISCONNECTED', 'USER')).toBe('owner_disconnected')
    expect(removed('CHANGE_NUMBER')).toBe('number_changed')
    expect(removed('PRIMARY_INACTIVITY')).toBe('inactive')
    expect(removed('SOMETHING_NEW')).toBe('access_removed')
  })

  it('bans, restrictions, deletion and reconnection; anything else changes nothing', () => {
    expect(statusChangeFor(event({ event: 'DISABLED_UPDATE', banState: 'DISABLE' }))).toEqual({ status: 'disconnected', reason: 'banned' })
    expect(statusChangeFor(event({ event: 'DISABLED_UPDATE', banState: 'SCHEDULE_FOR_DISABLE' }))).toEqual({ status: 'restricted', reason: 'ban_scheduled' })
    expect(statusChangeFor(event({ event: 'ACCOUNT_RESTRICTION', restrictions: 1 }))).toEqual({ status: 'restricted', reason: 'restricted' })
    expect(statusChangeFor(event({ event: 'ACCOUNT_DELETED' }))).toEqual({ status: 'disconnected', reason: 'account_deleted' })
    expect(statusChangeFor(event({ event: 'ACCOUNT_RECONNECTED' }))).toEqual({ status: 'connected', reason: null })
    expect(statusChangeFor(event({ event: 'VOLUME_BASED_PRICING_TIER_UPDATE' }))).toBeNull()
  })

  it('a lifted restriction or ban clears only that cause, never a disconnection by the owner', async () => {
    const service = new ChannelStatusService(t.db)
    await service.apply(a.tenantId, event({ wabaId: a.wabaId, event: 'PARTNER_REMOVED', disconnection: { reason: 'ACCOUNT_DISCONNECTED', initiatedBy: 'USER' } }))
    await service.apply(a.tenantId, event({ wabaId: a.wabaId, event: 'ACCOUNT_RESTRICTION', restrictions: 0 }))
    await service.apply(a.tenantId, event({ wabaId: a.wabaId, event: 'DISABLED_UPDATE', banState: 'REINSTATE' }))
    expect(await channelOf(a)).toMatchObject({ status: 'disconnected', reason: 'owner_disconnected' })

    await service.apply(a.tenantId, event({ wabaId: a.wabaId, event: 'ACCOUNT_RESTRICTION', restrictions: 2 }))
    expect(await channelOf(a)).toMatchObject({ status: 'restricted', reason: 'restricted' })
    await service.apply(a.tenantId, event({ wabaId: a.wabaId, event: 'ACCOUNT_RESTRICTION', restrictions: 0 }))
    expect(await channelOf(a)).toMatchObject({ status: 'connected', reason: null })
  })
})

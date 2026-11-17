// Coexistence: the owner keeps the WhatsApp Business app. What they write from the phone, the chats
// the app shares after onboarding and its contacts reach Vortomi through three webhooks. They are
// stored in the right company, in their real place in time, never answered by the bot, and a chunk
// Meta sends twice changes nothing.
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, messages } from '../../src/db/schema/index.ts'
import type { MemberScope } from '../../src/modules/access/member-scope.ts'
import { ConversationQueries } from '../../src/modules/conversations/conversation-queries.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { EventRouter } from '../../src/modules/inbox/event-router.ts'
import { ChannelDirectory } from '../../src/modules/tenancy/channel-directory.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { parseWebhookPayload } from '../../src/modules/whatsapp/webhook-parser.ts'
import { PHONE_UNKNOWN, textChange, unix, webhook } from '../helpers/meta-payloads.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let router: EventRouter
const answered: string[] = []

const CUSTOMER = '584125550111'
const OLD_CUSTOMER = '584125550222'
const BUSINESS = '584125550000'

/** A coexistence change as Meta sends it. */
const coexChange = (phoneNumberId: string, field: string, value: object) => ({
  field,
  value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS, phone_number_id: phoneNumberId }, ...value },
})

const echo = (phoneNumberId: string, id: string, body: string, to = CUSTOMER, at = new Date()) =>
  coexChange(phoneNumberId, 'smb_message_echoes', { message_echoes: [{ from: BUSINESS, to, id, timestamp: unix(at), type: 'text', text: { body } }] })

const day = (n: number) => new Date(Date.UTC(2026, 7, n, 15, 0, 0))

/** Runs a webhook the way the inbox does: parse, then route every event. */
async function deliver(payload: object) {
  const { events, skipped } = parseWebhookPayload(payload)
  const outcomes = []
  for (const event of events) outcomes.push(await router.handle(event))
  return { outcomes, skipped }
}

const conversationOf = (tenantId: string, waId: string) =>
  withTenant(t.db, tenantId, async ({ tx }) => {
    const [row] = await tx
      .select({ id: conversations.id, status: conversations.status, lastActivityAt: conversations.lastActivityAt, name: contacts.name, contactId: contacts.id })
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .where(eq(contacts.waId, waId))
    return row
  })

const messagesOf = (tenantId: string, conversationId: string) =>
  withTenant(t.db, tenantId, ({ tx }) => tx.select().from(messages).where(eq(messages.conversationId, conversationId)))

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  router = new EventRouter(t.db, new ChannelDirectory(t.db), new IngestService(), new MessageStatusService(), { applyStatus: () => Promise.resolve() }, {
    afterInbound: (_tenantId, trigger) => {
      answered.push(trigger.waMessageId)
      return Promise.resolve()
    },
  })
})

afterAll(async () => {
  await t.close()
})

describe('what the owner writes from the phone', () => {
  it('shows in the conversation as the owner\'s, in the right company, and the bot does not answer it', async () => {
    await deliver(webhook(textChange(a.phoneNumberId, 'wamid.customer.1', 'Hola, ¿tienen pan canilla?', CUSTOMER)))
    const result = await deliver(webhook(echo(a.phoneNumberId, 'wamid.owner.1', 'Sí, hay pan canilla recién salido')))
    expect(result.outcomes).toEqual(['handled'])

    const conversation = await conversationOf(a.tenantId, CUSTOMER)
    const stored = await messagesOf(a.tenantId, conversation!.id)
    expect(stored.find((m) => m.waMessageId === 'wamid.owner.1')).toMatchObject({ direction: 'out', author: 'owner_app', type: 'text', body: 'Sí, hay pan canilla recién salido' })
    expect(answered).toEqual(['wamid.customer.1'])
    expect(await conversationOf(b.tenantId, CUSTOMER)).toBeUndefined()
  })

  it('a repeated echo is stored once', async () => {
    await deliver(webhook(echo(a.phoneNumberId, 'wamid.owner.1', 'Sí, hay pan canilla recién salido')))
    const conversation = await conversationOf(a.tenantId, CUSTOMER)
    expect((await messagesOf(a.tenantId, conversation!.id)).filter((m) => m.waMessageId === 'wamid.owner.1')).toHaveLength(1)
  })

  it('a conversation the owner starts from the phone does not land in the team\'s queue', async () => {
    await deliver(webhook(echo(a.phoneNumberId, 'wamid.owner.new', 'Buenos días, su pedido está listo', '584125550333')))
    expect(await conversationOf(a.tenantId, '584125550333')).toMatchObject({ status: 'resolved' })
  })

  it('an echo of a number no company owns is set aside', async () => {
    expect((await deliver(webhook(echo(PHONE_UNKNOWN, 'wamid.owner.x', 'hola')))).outcomes).toEqual(['unroutable'])
  })
})

describe('the chats the owner\'s app shares after connecting', () => {
  const chunk = (order: number, messagesOfThread: object[], waId = OLD_CUSTOMER) =>
    webhook(
      coexChange(a.phoneNumberId, 'history', {
        history: [{ metadata: { phase: 1, chunk_order: order, progress: order === 2 ? 100 : 40 }, threads: [{ id: waId, context: { wa_id: waId }, messages: messagesOfThread }] }],
      }),
    )
  const said = (id: string, at: Date, body: string) => ({ from: OLD_CUSTOMER, id, timestamp: unix(at), type: 'text', text: { body }, history_context: { status: 'read' } })
  const replied = (id: string, at: Date, body: string) => ({ from: BUSINESS, to: OLD_CUSTOMER, id, timestamp: unix(at), type: 'text', text: { body }, history_context: { status: 'read' } })

  it('stores months-old chats with their own time, as a resolved conversation with nothing unread', async () => {
    // Chunks may arrive out of order.
    await deliver(chunk(2, [said('wamid.h.3', day(20), 'Gracias, llegó bien'), { from: OLD_CUSTOMER, id: 'wamid.h.4', timestamp: unix(day(21)), type: 'media_placeholder' }]))
    await deliver(chunk(1, [said('wamid.h.1', day(10), '¿Hacen tortas por encargo?'), replied('wamid.h.2', day(10), 'Sí, con dos días de anticipación')]))

    const conversation = await conversationOf(a.tenantId, OLD_CUSTOMER)
    expect(conversation).toMatchObject({ status: 'resolved', lastActivityAt: day(21) })
    const stored = await messagesOf(a.tenantId, conversation!.id)
    expect(stored.map((m) => [m.waMessageId, m.direction, m.author, m.createdAt.toISOString()]).sort()).toEqual([
      ['wamid.h.1', 'in', 'customer', day(10).toISOString()],
      ['wamid.h.2', 'out', 'owner_app', day(10).toISOString()],
      ['wamid.h.3', 'in', 'customer', day(20).toISOString()],
      ['wamid.h.4', 'in', 'customer', day(21).toISOString()],
    ])
    expect(stored.find((m) => m.waMessageId === 'wamid.h.4')).toMatchObject({ type: 'unsupported', body: null })
    expect(answered).not.toContain('wamid.h.1')
  })

  it('the conversation reads in the order things were said, even though the chunks came backwards', async () => {
    const conversation = await conversationOf(a.tenantId, OLD_CUSTOMER)
    const scope = (tx: MemberScope['tx']) => ({ tx, tenantId: a.tenantId, member: { userId: 'x', role: 'admin', canSeeOthers: true } }) as MemberScope
    const firstPage = await withTenant(t.db, a.tenantId, ({ tx }) => new ConversationQueries().messages(scope(tx), conversation!.id, 2))
    expect(firstPage.items.map((m) => m.body)).toEqual([null, 'Gracias, llegó bien'])
    const older = await withTenant(t.db, a.tenantId, ({ tx }) => new ConversationQueries().messages(scope(tx), conversation!.id, 5, firstPage.nextBeforeId!))
    expect(older.items.map((m) => m.body)).toEqual(['Sí, con dos días de anticipación', '¿Hacen tortas por encargo?'])
  })

  it('a chunk Meta sends again adds nothing', async () => {
    await deliver(chunk(1, [said('wamid.h.1', day(10), '¿Hacen tortas por encargo?'), replied('wamid.h.2', day(10), 'Sí, con dos días de anticipación')]))
    const conversation = await conversationOf(a.tenantId, OLD_CUSTOMER)
    expect(await messagesOf(a.tenantId, conversation!.id)).toHaveLength(4)
  })

  it('history the owner chose not to share is noted, not an error', async () => {
    const declined = webhook(
      coexChange(a.phoneNumberId, 'history', {
        history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App.' }] }],
      }),
    )
    expect(await deliver(declined)).toEqual({ outcomes: [], skipped: ['history_declined'] })
  })
})

describe('the contacts of the owner\'s app', () => {
  const sync = (items: object[]) => webhook(coexChange(a.phoneNumberId, 'smb_app_state_sync', { state_sync: items }))
  const contact = (phone: string, name: string | null, action: 'add' | 'remove', at = new Date()) => ({
    type: 'contact',
    contact: { ...(name ? { full_name: name, first_name: name.split(' ')[0] } : {}), phone_number: phone },
    action,
    metadata: { timestamp: unix(at) },
  })

  it('names the customers the owner saved, and adds the ones Vortomi did not know, without opening conversations', async () => {
    await deliver(sync([contact('+58 412-555 0111', 'Sra. María (pedidos)', 'add'), contact('584125550444', 'Pedro Panadería', 'add')]))
    expect(await conversationOf(a.tenantId, CUSTOMER)).toMatchObject({ name: 'Sra. María (pedidos)' })
    const added = await withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(contacts).where(eq(contacts.waId, '584125550444')))
    expect(added).toMatchObject([{ name: 'Pedro Panadería', channelAccountId: a.channelAccountId }])
    expect(await conversationOf(a.tenantId, '584125550444')).toBeUndefined()
  })

  it('a name typed in Vortomi wins, and a contact deleted on the phone stays in Vortomi', async () => {
    const before = await conversationOf(a.tenantId, CUSTOMER)
    await withTenant(t.db, a.tenantId, ({ tx }) => tx.update(contacts).set({ name: 'María Pérez' }).where(eq(contacts.id, before!.contactId)))
    await deliver(sync([contact('584125550111', 'Otro nombre', 'add'), contact('584125550444', null, 'remove')]))
    expect(await conversationOf(a.tenantId, CUSTOMER)).toMatchObject({ name: 'María Pérez' })
    expect(await withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(contacts).where(eq(contacts.waId, '584125550444')))).toHaveLength(1)
  })
})

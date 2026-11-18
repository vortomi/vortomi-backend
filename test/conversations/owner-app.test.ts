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
import { dbError } from '../helpers/db-error.ts'
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
      .select({ id: conversations.id, status: conversations.status, lastActivityAt: conversations.lastActivityAt, agentPausedUntil: conversations.agentPausedUntil, name: contacts.name, contactId: contacts.id })
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
    // The owner is answering: the agent leaves it to them for 30 minutes.
    expect(conversation!.agentPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000)
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
    // Months-old chats pause nothing: only a live message of the owner does.
    expect(conversation).toMatchObject({ status: 'resolved', lastActivityAt: day(21), agentPausedUntil: null })
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

describe('the photos and files of the history (last 14 days)', () => {
  // Meta's separate media webhook: field "history" with no "history" array, the file in "messages"
  // (customer's) or "message_echoes" (the business's own).
  const media = (value: object) => webhook(coexChange(a.phoneNumberId, 'history', value))
  const photo = (id: string, at: Date, caption?: string) => ({
    from: OLD_CUSTOMER,
    from_user_id: 'VE.123',
    id,
    timestamp: unix(at),
    type: 'image',
    image: { ...(caption ? { caption } : {}), mime_type: 'image/jpeg', sha256: 'abc', id: `media-${id}` },
  })
  const placeholder = (id: string, at: Date, from = OLD_CUSTOMER) => ({ from, id, timestamp: unix(at), type: 'media_placeholder', history_context: { status: 'read' } })
  const historyChunk = (items: object[]) =>
    webhook(coexChange(a.phoneNumberId, 'history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: OLD_CUSTOMER, messages: items }] }] }))
  const stored = async (id: string) => {
    const conversation = await conversationOf(a.tenantId, OLD_CUSTOMER)
    return (await messagesOf(a.tenantId, conversation!.id)).filter((m) => m.waMessageId === id)
  }

  it('the photo fills the placeholder the history left: its type, caption and file id, in its place', async () => {
    // wamid.h.4 arrived above as a content-less placeholder.
    await deliver(media({ messages: [photo('wamid.h.4', day(21), 'Así quedó la torta')] }))
    expect(await stored('wamid.h.4')).toMatchObject([
      { type: 'image', body: 'Así quedó la torta', waMediaId: 'media-wamid.h.4', direction: 'in', createdAt: day(21) },
    ])
  })

  it('a photo that comes before its placeholder is stored, and the placeholder after it changes nothing', async () => {
    await deliver(media({ messages: [photo('wamid.h.5', day(22))] }))
    await deliver(historyChunk([placeholder('wamid.h.5', day(22))]))
    expect(await stored('wamid.h.5')).toMatchObject([{ type: 'image', body: null, waMediaId: 'media-wamid.h.5', createdAt: day(22) }])
  })

  it('the owner\'s own file, from message_echoes, fills its placeholder as the owner\'s', async () => {
    await deliver(historyChunk([placeholder('wamid.h.6', day(23), BUSINESS)]))
    const pdf = { from: BUSINESS, to: OLD_CUSTOMER, id: 'wamid.h.6', timestamp: unix(day(23)), type: 'document', document: { caption: 'Menú', mime_type: 'application/pdf', sha256: 'x', id: 'media-pdf' } }
    await deliver(media({ message_echoes: [pdf] }))
    expect(await stored('wamid.h.6')).toMatchObject([{ type: 'document', body: 'Menú', waMediaId: 'media-pdf', direction: 'out', author: 'owner_app' }])
  })

  it('a file Meta sends twice, or something that is not a file, overwrites nothing', async () => {
    await deliver(media({ messages: [photo('wamid.h.4', day(21), 'Otro texto')] }))
    const text = { from: OLD_CUSTOMER, id: 'wamid.h.5', timestamp: unix(day(22)), type: 'text', text: { body: 'no soy una foto' } }
    expect((await deliver(media({ messages: [text] }))).skipped).toEqual(['invalid_history_media'])
    expect(await stored('wamid.h.4')).toMatchObject([{ body: 'Así quedó la torta' }])
    expect(await stored('wamid.h.5')).toMatchObject([{ type: 'image' }])
    expect(answered).not.toContain('wamid.h.4')
  })

  it('the database allows only that: a placeholder filled once with a file, nothing else, by anyone', async () => {
    const [filled] = await stored('wamid.h.4')
    const [text] = await stored('wamid.h.3')
    await deliver(historyChunk([placeholder('wamid.h.7', day(24))]))
    const [open] = await stored('wamid.h.7')
    const update = (id: number, values: Partial<typeof messages.$inferInsert>) => dbError(t.db.update(messages).set(values).where(eq(messages.id, id)))
    // Filled once: no second file, no new caption.
    expect(await update(filled!.id, { waMediaId: 'media-other' })).toMatch(/already has its send result|never rewritten/)
    expect(await update(filled!.id, { body: 'Otro texto' })).toMatch(/already has its send result|never rewritten/)
    // An ordinary message never turns into a file.
    expect(await update(text!.id, { type: 'image', waMediaId: 'media-x' })).toMatch(/already has its send result|never rewritten/)
    // A placeholder only becomes a file: not text, and not with its author or time changed.
    expect(await update(open!.id, { type: 'text', body: 'inventado' })).toMatch(/already has its send result|never rewritten/)
    expect(await update(open!.id, { type: 'image', waMediaId: 'media-y', direction: 'out' })).toMatch(/already has its send result|never rewritten/)
    expect(await update(open!.id, { type: 'image', waMediaId: 'media-y', createdAt: day(1) })).toMatch(/already has its send result|never rewritten/)
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

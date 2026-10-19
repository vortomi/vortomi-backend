// Replying from the panel: once per click, only inside the 24 h window, only with the
// number's own token, and never through a conversation the person cannot see.
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { channelCredentials, messages } from '../../src/db/schema/index.ts'
import type { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { MessageStatusService } from '../../src/modules/conversations/message-status.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { FakeSender, buildTestApp, testCredentials } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const TOKEN_A = 'EAAG-token-of-company-a'
const HOUR = 3_600_000

let t: TestDatabase
let app: FastifyInstance
let sender: FakeSender
let credentials: ChannelCredentials
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '' }
const chats = { open: '', expired: '', hidden: '', inB: '' }

async function conversationWith(tenant: SeededTenant, waId: string, hoursAgo: number): Promise<string> {
  const event = {
    kind: 'inbound_message' as const,
    phoneNumberId: tenant.phoneNumberId,
    waMessageId: `wamid.${randomUUID()}`,
    timestamp: new Date(Date.now() - hoursAgo * HOUR),
    from: waId,
    profileName: null,
    type: 'text' as const,
    body: 'Hola',
    replyId: null,
    waMediaId: null,
  }
  const record = await withTenant(t.db, tenant.tenantId, (scope) => new IngestService().recordInbound(scope, tenant.channelAccountId, event))
  return record.conversationId
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin', channelAccountIds: [b.channelAccountId] })

  chats.open = await conversationWith(a, '584120000001', 1)
  chats.expired = await conversationWith(a, '584120000002', 30)
  chats.hidden = await conversationWith(a, '584120000003', 1)
  chats.inB = await conversationWith(b, '584120000009', 1)
  await withTenant(t.db, a.tenantId, ({ tx }) => tx.execute(sql`update conversations set assigned_user_id = ${who.laura} where id = ${chats.hidden}`))

  sender = new FakeSender()
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, TOKEN_A)
  app = await buildTestApp(t.db, { sender, credentials })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const send = async (userId: string, tenantId: string, conversationId: string, clientMessageId = randomUUID(), body = 'Sí, las tenemos') =>
  app.inject({
    method: 'POST',
    url: `/api/tenants/${tenantId}/conversations/${conversationId}/messages`,
    headers: await bearer(userId),
    payload: { body, clientMessageId },
  })
const messagesOf = async (userId: string, conversationId: string) =>
  (
    await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/conversations/${conversationId}/messages`, headers: await bearer(userId) })
  ).json<{ items: { body: string; direction: string; status: string | null; authorUserId: string | null; clientMessageId: string | null }[] }>().items
const countOut = async () => (await t.db.select({ id: messages.id }).from(messages).where(eq(messages.direction, 'out'))).length

describe('sending a reply', () => {
  const clientMessageId = randomUUID()

  it('sends with the number id and that number decrypted token, and stores who wrote it', async () => {
    const response = await send(who.laura, a.tenantId, chats.open, clientMessageId)
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ outcome: 'sent' })
    expect(sender.sent).toEqual([{ phoneNumberId: a.phoneNumberId, accessToken: TOKEN_A, to: '584120000001', body: 'Sí, las tenemos' }])
    const [latest] = await messagesOf(who.laura, chats.open)
    expect(latest).toMatchObject({ direction: 'out', body: 'Sí, las tenemos', authorUserId: who.laura, status: 'pending', clientMessageId })
  })

  it('a retried request (same clientMessageId) answers the same and sends nothing', async () => {
    const response = await send(who.laura, a.tenantId, chats.open, clientMessageId)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ outcome: 'already_sent' })
    expect(sender.sent).toHaveLength(1)
  })

  it('shows the status Meta reports afterwards', async () => {
    await withTenant(t.db, a.tenantId, (scope) =>
      new MessageStatusService().record(scope, {
        kind: 'status_update',
        phoneNumberId: a.phoneNumberId,
        waMessageId: 'wamid.out.1',
        timestamp: new Date(),
        status: 'delivered',
        pricing: null,
        errorText: null,
      }),
    )
    expect((await messagesOf(who.laura, chats.open))[0]).toMatchObject({ status: 'delivered' })
  })

  it('records a Meta rejection as failed, without retrying', async () => {
    sender.failNextWith(131047, 'Re-engagement message')
    const response = await send(who.laura, a.tenantId, chats.open)
    expect(response.json()).toMatchObject({ outcome: 'failed' })
    expect((await messagesOf(who.laura, chats.open))[0]).toMatchObject({ status: 'failed' })
    expect(sender.sent).toHaveLength(2)
  })
})

describe('refusing to send', () => {
  it('outside the 24 h window, and stores nothing', async () => {
    const before = await countOut()
    const response = await send(who.laura, a.tenantId, chats.expired)
    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ error: 'service_window_closed' })
    expect(await countOut()).toBe(before)
  })

  it('through a conversation the person cannot see, or of another company', async () => {
    const sentBefore = sender.sent.length
    expect((await send(who.carlos, a.tenantId, chats.hidden)).json()).toEqual({ error: 'conversation_not_found' })
    expect((await send(who.laura, a.tenantId, chats.inB)).json()).toEqual({ error: 'conversation_not_found' })
    expect((await send(who.pedro, a.tenantId, chats.open)).json()).toEqual({ error: 'not_a_member' })
    expect(sender.sent).toHaveLength(sentBefore)
  })

  it('a number without credentials fails cleanly instead of borrowing another token', async () => {
    const sentBefore = sender.sent.length
    const response = await send(who.pedro, b.tenantId, chats.inB)
    expect(response.json()).toMatchObject({ outcome: 'failed' })
    expect(sender.sent).toHaveLength(sentBefore)
  })

  it('a too long or empty message is rejected before anything happens', async () => {
    expect((await send(who.laura, a.tenantId, chats.open, randomUUID(), 'x'.repeat(4097))).statusCode).toBe(400)
    expect((await send(who.laura, a.tenantId, chats.open, randomUUID(), '   ')).statusCode).toBe(400)
  })
})

describe('what the database guarantees', () => {
  it('company code cannot read any credential, not even its own', async () => {
    const attempt = withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(channelCredentials))
    expect(await dbError(attempt)).toMatch(/permission denied/)
  })

  it('stores the token encrypted, bound to its number', async () => {
    const [row] = await t.db.select().from(channelCredentials).where(eq(channelCredentials.channelAccountId, a.channelAccountId))
    expect(row!.encryptedAccessToken).not.toContain(TOKEN_A)
    // The same ciphertext pasted on another number does not decrypt.
    await t.db.insert(channelCredentials).values({ tenantId: b.tenantId, channelAccountId: b.channelAccountId, encryptedAccessToken: row!.encryptedAccessToken })
    await expect(credentials.accessTokenFor(b.tenantId, b.channelAccountId)).rejects.toThrow(/cannot be decrypted/)
  })

  it('a sent message gets its result once and is never rewritten', async () => {
    const [sent] = await t.db.select({ id: messages.id }).from(messages).where(and(eq(messages.direction, 'out'), eq(messages.waMessageId, 'wamid.out.1')))
    expect(await dbError(t.db.update(messages).set({ waMessageId: 'wamid.other' }).where(eq(messages.id, sent!.id)))).toMatch(/already has its send result/)
    const [inbound] = await t.db.select({ id: messages.id }).from(messages).where(eq(messages.direction, 'in')).limit(1)
    expect(await dbError(t.db.update(messages).set({ body: 'editado' }).where(eq(messages.id, inbound!.id)))).toMatch(/already has its send result|never rewritten/)
  })
})

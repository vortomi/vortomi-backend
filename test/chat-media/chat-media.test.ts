// The files of the chat (option B, mockup web-24): a photo, a voice note, a sticker or a document
// is copied while Meta still has it (7 days) — photos, voice notes and stickers to Cloudinary,
// documents up to 5 MB to Supabase Storage — and the panel gets it through our API, only where the
// person may see that conversation. Videos and larger documents stay on the phone.
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatMediaKind } from '../../src/db/schema/index.ts'
import { messageMedia, messages } from '../../src/db/schema/index.ts'
import { MediaArchiver, type MediaStores } from '../../src/modules/chat-media/media-archiver.ts'
import type { MediaFile, MediaStore, MediaVariant } from '../../src/modules/chat-media/media-store.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { type DownloadedMedia, type MediaDownloader, MediaTooLargeError } from '../../src/modules/whatsapp/cloud-api.client.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import { buildTestApp, silentLog, testCredentials } from '../helpers/app.ts'
import { bearer, seedAssignees, seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

/** Meta's side: each media id answers its file, a failure or "too large". */
class FakeMeta implements MediaDownloader {
  readonly files = new Map<string, DownloadedMedia | Error>()
  readonly asked: { mediaId: string; maxBytes: number | undefined }[] = []
  downloadMedia(mediaId: string, _token: string, maxBytes?: number): Promise<DownloadedMedia> {
    this.asked.push({ mediaId, maxBytes })
    const file = this.files.get(mediaId)
    if (!file) return Promise.reject(new Error('Meta has no such media'))
    return file instanceof Error ? Promise.reject(file) : Promise.resolve(file)
  }
}

/** A store in memory: what was put, and which copy was read. */
class FakeStore implements MediaStore {
  readonly kept = new Map<string, { kind: ChatMediaKind; file: MediaFile }>()
  readonly reads: MediaVariant[] = []
  put(key: string, kind: ChatMediaKind, file: MediaFile) {
    this.kept.set(`obj/${key}`, { kind, file })
    return Promise.resolve({ objectKey: `obj/${key}`, sizeBytes: file.bytes.length })
  }
  get(objectKey: string, _kind: ChatMediaKind, variant: MediaVariant) {
    this.reads.push(variant)
    const kept = this.kept.get(objectKey)
    return kept ? Promise.resolve(kept.file) : Promise.reject(new Error('missing'))
  }
}

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let app: FastifyInstance
const meta = new FakeMeta()
const cloudinary = new FakeStore()
const supabase = new FakeStore()
const stores: MediaStores = { cloudinary, supabase }
// Rows are stamped with the real time: the archiver's clock is set just after they are made.
let clock = new Date()
const who = { laura: '', carlos: '', pedro: '' }
let conversationId = ''
const ids: Record<string, number> = {}

const file = (text: string, mimeType: string) => ({ bytes: Buffer.from(text), mimeType })
const archiverWith = (configured: MediaStores) => new MediaArchiver(t.db, credentials, meta, configured, silentLog, () => clock)
let credentials: ReturnType<typeof testCredentials>

function inbound(waMessageId: string, content: Partial<InboundMessageEvent>): InboundMessageEvent {
  return { kind: 'inbound_message', phoneNumberId: a.phoneNumberId, waMessageId, timestamp: clock, from: '584125550777', profileName: 'Ana', type: 'text', body: null, replyId: null, waMediaId: null, ...content }
}
async function receive(waMessageId: string, content: Partial<InboundMessageEvent>) {
  const record = await withTenant(t.db, a.tenantId, (scope) => new IngestService().recordInbound(scope, a.channelAccountId, inbound(waMessageId, content)))
  conversationId = record.conversationId
  const [row] = await t.db.select({ id: messages.id }).from(messages).where(and(eq(messages.tenantId, a.tenantId), eq(messages.waMessageId, waMessageId)))
  ids[waMessageId] = row!.id
}
const mediaRow = async (waMessageId: string) =>
  (await t.db.select().from(messageMedia).where(and(eq(messageMedia.tenantId, a.tenantId), eq(messageMedia.messageId, ids[waMessageId]!))))[0]
const mediaUrl = (waMessageId: string, query = '') => `/api/tenants/${a.tenantId}/conversations/${conversationId}/messages/${ids[waMessageId]}/media${query}`

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  credentials = testCredentials(t.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'EAAtest-token-of-number-a')
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin', channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin', channelAccountIds: [b.channelAccountId] })
  app = await buildTestApp(t.db, { mediaStores: stores })

  meta.files.set('m-photo', file('jpeg-bytes', 'image/jpeg'))
  meta.files.set('m-voice', file('ogg-bytes', 'audio/ogg; codecs=opus'))
  meta.files.set('m-doc', file('%PDF-1.7', 'application/pdf'))
  meta.files.set('m-page', file('<script>alert(1)</script>', 'text/html'))
  meta.files.set('m-big', new MediaTooLargeError(18 * 1024 * 1024))
  await receive('w-photo', { type: 'image', waMediaId: 'm-photo', body: 'Quiero una así' })
  await receive('w-voice', { type: 'audio', waMediaId: 'm-voice' })
  await receive('w-doc', { type: 'document', waMediaId: 'm-doc', fileName: 'Menú de tortas.pdf' })
  await receive('w-page', { type: 'document', waMediaId: 'm-page', fileName: 'pagina.html' })
  await receive('w-big', { type: 'document', waMediaId: 'm-big', fileName: 'Catálogo completo.pdf' })
  await receive('w-video', { type: 'video', waMediaId: 'm-video' })
  await receive('w-text', { type: 'text', body: 'Hola' })
  clock = new Date(Date.now() + 1000)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

describe('noting the files to copy', () => {
  it('photos, voice notes and documents wait to be copied, with the document\'s name; videos and text are not noted', async () => {
    expect(await mediaRow('w-photo')).toMatchObject({ kind: 'image', status: 'pending', fileName: null })
    expect(await mediaRow('w-voice')).toMatchObject({ kind: 'audio', status: 'pending' })
    expect(await mediaRow('w-doc')).toMatchObject({ kind: 'document', status: 'pending', fileName: 'Menú de tortas.pdf' })
    expect(await mediaRow('w-video')).toBeUndefined()
    expect(await mediaRow('w-text')).toBeUndefined()
  })
})

describe('copying them while Meta has them', () => {
  it('without its store, a file waits: nothing is tried and nothing is lost', async () => {
    expect(await archiverWith({ cloudinary: null, supabase: null }).runDue()).toBe(0)
    expect(meta.asked).toEqual([])
  })

  it('photos and voice notes go to Cloudinary, documents to Supabase; a document over 5 MB stays on the phone', async () => {
    await archiverWith(stores).runDue()
    expect(await mediaRow('w-photo')).toMatchObject({ status: 'stored', storage: 'cloudinary', objectKey: `obj/${a.tenantId}/${ids['w-photo']}`, mimeType: 'image/jpeg' })
    expect(await mediaRow('w-voice')).toMatchObject({ status: 'stored', storage: 'cloudinary' })
    expect(await mediaRow('w-doc')).toMatchObject({ status: 'stored', storage: 'supabase', sizeBytes: 8 })
    expect(await mediaRow('w-big')).toMatchObject({ status: 'too_large', sizeBytes: 18 * 1024 * 1024 })
    // Each kind is asked with its own ceiling: 5 MB documents and photos, 16 MB voice notes.
    expect(meta.asked.find((q) => q.mediaId === 'm-voice')?.maxBytes).toBe(16 * 1024 * 1024)
    expect(meta.asked.find((q) => q.mediaId === 'm-doc')?.maxBytes).toBe(5 * 1024 * 1024)
    expect([...cloudinary.kept.values()].map((k) => k.kind).sort()).toEqual(['audio', 'image'])
  })

  it('a failed download is tried again later, not at once; after 7 days it is given up', async () => {
    await receive('w-later', { type: 'image', waMediaId: 'm-missing' })
    clock = new Date(Date.now() + 1000)
    await archiverWith(stores).runDue()
    const waiting = await mediaRow('w-later')
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 })
    expect(waiting!.nextAttemptAt.getTime()).toBe(clock.getTime() + 60_000)
    const asked = meta.asked.length
    await archiverWith(stores).runDue()
    expect(meta.asked).toHaveLength(asked)

    clock = new Date(clock.getTime() + 8 * 24 * 60 * 60_000)
    await archiverWith(stores).runDue()
    expect(await mediaRow('w-later')).toMatchObject({ status: 'unavailable' })
  })
})

describe('the panel getting a file', () => {
  it('the messages say how each file is, never where', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tenants/${a.tenantId}/conversations/${conversationId}/messages`, headers: await bearer(who.laura) })
    const items = response.json<{ items: { id: number; type: string; media: unknown }[] }>().items
    expect(items.find((m) => m.id === ids['w-doc'])?.media).toEqual({ status: 'stored', fileName: 'Menú de tortas.pdf', sizeBytes: 8 })
    expect(items.find((m) => m.id === ids['w-big'])?.media).toMatchObject({ status: 'too_large' })
    expect(items.find((m) => m.id === ids['w-video'])?.media).toBeNull()
    expect(response.body).not.toContain('obj/')
  })

  it('the photo comes through our API, small for the chat, kept by the browser, unable to run anything', async () => {
    const response = await app.inject({ method: 'GET', url: mediaUrl('w-photo', '?size=thumb'), headers: await bearer(who.laura) })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('jpeg-bytes')
    expect(cloudinary.reads.at(-1)).toBe('thumb')
    expect(response.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    })
  })

  it('a document keeps its name; one a browser could run (a web page) is only ever downloaded', async () => {
    const pdf = await app.inject({ method: 'GET', url: mediaUrl('w-doc'), headers: await bearer(who.laura) })
    expect(pdf.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('Menú de tortas.pdf')}`)
    const page = await app.inject({ method: 'GET', url: mediaUrl('w-page'), headers: await bearer(who.laura) })
    expect(page.headers['content-type']).toBe('application/octet-stream')
    expect(page.headers['content-disposition']).toMatch(/^attachment;/)
  })

  it('only who may see the conversation gets it: not an agent it is not assigned to, not another company', async () => {
    expect((await app.inject({ method: 'GET', url: mediaUrl('w-photo'), headers: await bearer(who.carlos) })).json()).toEqual({ error: 'conversation_not_found' })
    await seedAssignees(t.db, a.tenantId, conversationId, who.carlos)
    expect((await app.inject({ method: 'GET', url: mediaUrl('w-photo'), headers: await bearer(who.carlos) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: mediaUrl('w-photo'), headers: await bearer(who.pedro) })).statusCode).toBe(403)
  })

  it('a file not kept (too large, a video, a wrong id) answers one same «not found»', async () => {
    for (const url of [mediaUrl('w-big'), mediaUrl('w-video'), `/api/tenants/${a.tenantId}/conversations/${conversationId}/messages/999999/media`]) {
      expect((await app.inject({ method: 'GET', url, headers: await bearer(who.laura) })).json()).toEqual({ error: 'media_not_found' })
    }
  })
})

describe('the database rules', () => {
  it('company code can follow a copy\'s progress, never move it to another message or kind', async () => {
    const asCompany = (work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]['tx']) => PromiseLike<unknown>) =>
      dbError(withTenant(t.db, a.tenantId, async ({ tx }) => await work(tx)))
    expect(await asCompany((tx) => tx.update(messageMedia).set({ kind: 'audio' }).where(eq(messageMedia.messageId, ids['w-photo']!)))).toMatch(/permission denied/)
    expect(await asCompany((tx) => tx.update(messageMedia).set({ messageId: ids['w-text']! }).where(eq(messageMedia.messageId, ids['w-photo']!)))).toMatch(/permission denied/)
    expect(await asCompany((tx) => tx.delete(messageMedia).where(eq(messageMedia.messageId, ids['w-photo']!)))).toMatch(/permission denied/)
  })

  it('a file of another company is invisible, and none can hang from another company\'s message', async () => {
    const seen = await withTenant(t.db, b.tenantId, ({ tx }) => tx.select().from(messageMedia))
    expect(seen).toEqual([])
    const linked = dbError(t.db.insert(messageMedia).values({ tenantId: b.tenantId, messageId: ids['w-text']!, kind: 'image' }))
    expect(await linked).toMatch(/message_media_message_fk/)
  })
})

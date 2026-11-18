import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../db/client.ts'
import { type ChatMediaKind, type ChatMediaStatus, contacts, conversations, messageMedia, messages } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import { withTenant } from '../tenancy/tenant-scope.ts'
import { type MediaDownloader, MediaTooLargeError } from '../whatsapp/cloud-api.client.ts'
import type { MediaStore } from './media-store.ts'
import { MAX_DOCUMENT_BYTES } from './supabase-store.ts'

/** Meta keeps a customer's file this long (Cloud API media docs: webhook media ids expire after 7 days). */
const META_KEEPS_MS = 7 * 24 * 60 * 60_000
/** Waits between attempts, in minutes; after the last one the file is given up. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720]
/** The largest file of each kind we copy (Meta's limits: images 5 MB, audio 16 MB, stickers 500 KB). */
const MAX_BYTES: Record<ChatMediaKind, number> = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  sticker: 1024 * 1024,
  document: MAX_DOCUMENT_BYTES,
}
const BATCH = 10

/** Where each kind goes; a store not configured leaves its files waiting. */
export interface MediaStores {
  cloudinary: MediaStore | null
  supabase: MediaStore | null
}

export const storeFor = (kind: ChatMediaKind): keyof MediaStores => (kind === 'document' ? 'supabase' : 'cloudinary')

interface Due {
  tenantId: string
  messageId: number
  kind: ChatMediaKind
  attempts: number
  waMediaId: string | null
  createdAt: Date
  channelAccountId: string
}

/**
 * Copies the files of the chat while Meta still has them (7 days): downloads each one with its
 * number's token and keeps it in its store (photos, voice notes and stickers in Cloudinary,
 * documents in Supabase). Runs apart from the webhooks, one file at a time, and is woken when a
 * message brings a file; a periodic run catches what a restart or a failure left behind.
 */
export class MediaArchiver {
  private running: Promise<void> | null = null
  private again = false

  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly meta: MediaDownloader,
    private readonly stores: MediaStores,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts a run now, or right after the one in progress. */
  wake(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.wake()
      }
    })
  }

  /** Resolves when no run is in progress (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  /** Copies what is due, a batch at a time, until nothing is. Returns how many files it handled. */
  async runDue(): Promise<number> {
    let handled = 0
    for (;;) {
      const due = await this.due()
      for (const row of due) {
        await this.copy(row)
        handled++
      }
      if (due.length < BATCH) return handled
    }
  }

  private async drain(): Promise<void> {
    await this.runDue().catch((error: unknown) => this.log.error({ err: error }, 'Chat media archiver failed'))
  }

  /** Every company's pending files whose turn came (server role: the queue spans companies). */
  private due(): Promise<Due[]> {
    const configured = (['cloudinary', 'supabase'] as const).filter((name) => this.stores[name])
    if (!configured.length) return Promise.resolve([])
    const kinds = configured.includes('supabase') ? (configured.includes('cloudinary') ? null : sql`${messageMedia.kind} = 'document'`) : sql`${messageMedia.kind} <> 'document'`
    return this.db
      .select({
        tenantId: messageMedia.tenantId,
        messageId: messageMedia.messageId,
        kind: messageMedia.kind,
        attempts: messageMedia.attempts,
        waMediaId: messages.waMediaId,
        createdAt: messages.createdAt,
        channelAccountId: contacts.channelAccountId,
      })
      .from(messageMedia)
      .innerJoin(messages, and(eq(messages.tenantId, messageMedia.tenantId), eq(messages.id, messageMedia.messageId)))
      .innerJoin(conversations, and(eq(conversations.tenantId, messages.tenantId), eq(conversations.id, messages.conversationId)))
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .where(and(eq(messageMedia.status, 'pending'), lte(messageMedia.nextAttemptAt, this.now()), kinds ?? undefined))
      .orderBy(asc(messageMedia.nextAttemptAt))
      .limit(BATCH)
  }

  private async copy(row: Due): Promise<void> {
    const store = this.stores[storeFor(row.kind)]
    if (!store) return
    if (!row.waMediaId || this.now().getTime() - row.createdAt.getTime() > META_KEEPS_MS) {
      await this.finish(row, 'unavailable', { lastError: 'Meta no longer keeps it' })
      return
    }
    try {
      const token = await this.credentials.accessTokenFor(row.tenantId, row.channelAccountId)
      if (!token) throw new Error('No access token for the number')
      const file = await this.meta.downloadMedia(row.waMediaId, token, MAX_BYTES[row.kind])
      const put = await store.put(`${row.tenantId}/${row.messageId}`, row.kind, file)
      await this.finish(row, 'stored', { storage: storeFor(row.kind), objectKey: put.objectKey, mimeType: file.mimeType, sizeBytes: file.bytes.length })
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        await this.finish(row, row.kind === 'document' ? 'too_large' : 'unavailable', { sizeBytes: error.sizeBytes, lastError: 'Too large to keep' })
        return
      }
      await this.retry(row, error)
    }
  }

  private async retry(row: Due, error: unknown): Promise<void> {
    // Only the kind of failure: errors here may quote a URL.
    const reason = (error instanceof Error ? `${error.name}: ${error.message}` : 'unknown').slice(0, 200)
    const wait = BACKOFF_MINUTES[row.attempts]
    if (wait === undefined) {
      this.log.error({ tenantId: row.tenantId, messageId: row.messageId, reason }, 'Chat file given up after every attempt')
      await this.finish(row, 'unavailable', { lastError: reason })
      return
    }
    this.log.warn({ tenantId: row.tenantId, messageId: row.messageId, reason, attempt: row.attempts + 1 }, 'Chat file not copied yet')
    await this.update(row, { attempts: row.attempts + 1, nextAttemptAt: new Date(this.now().getTime() + wait * 60_000), lastError: reason })
  }

  private finish(row: Due, status: Exclude<ChatMediaStatus, 'pending'>, fields: Partial<typeof messageMedia.$inferInsert>): Promise<void> {
    return this.update(row, { ...fields, status, attempts: row.attempts + 1 })
  }

  /** Inside the company's scope, as every write of company data. */
  private async update(row: Due, fields: Partial<typeof messageMedia.$inferInsert>): Promise<void> {
    await withTenant(this.db, row.tenantId, ({ tx }) =>
      tx
        .update(messageMedia)
        .set({ ...fields, updatedAt: this.now() })
        .where(and(eq(messageMedia.tenantId, row.tenantId), eq(messageMedia.messageId, row.messageId), eq(messageMedia.status, 'pending'))),
    )
  }
}

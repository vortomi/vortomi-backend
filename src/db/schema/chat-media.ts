import { sql } from 'drizzle-orm'
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz } from './columns.ts'
import { messages } from './conversations.ts'

/** What Vortomi keeps a copy of. Videos and anything else stay only on the phone. */
export const CHAT_MEDIA_KINDS = ['image', 'audio', 'sticker', 'document'] as const
export type ChatMediaKind = (typeof CHAT_MEDIA_KINDS)[number]

/**
 * pending: waiting to be copied (Meta keeps a customer's file 7 days).
 * stored: copied; storage and object_key say where.
 * too_large: a document over the limit (5 MB): open it on the phone.
 * unavailable: Meta no longer had it, or every attempt failed.
 */
export const CHAT_MEDIA_STATUSES = ['pending', 'stored', 'too_large', 'unavailable'] as const
export type ChatMediaStatus = (typeof CHAT_MEDIA_STATUSES)[number]

/** Photos, voice notes and stickers go to Cloudinary; documents to Supabase Storage. */
export const CHAT_MEDIA_STORAGES = ['cloudinary', 'supabase'] as const
export type ChatMediaStorage = (typeof CHAT_MEDIA_STORAGES)[number]

/**
 * Our copy of a file a message carried (option B, mockup web-24). One row per message, made when
 * the message is stored (status pending) and completed by the media archiver, outside any webhook.
 * The message itself is never rewritten; this row says where its file is.
 */
export const messageMedia = pgTable(
  'message_media',
  {
    tenantId: tenantIdColumn(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: CHAT_MEDIA_KINDS }).notNull(),
    status: text('status', { enum: CHAT_MEDIA_STATUSES }).notNull().default('pending'),
    storage: text('storage', { enum: CHAT_MEDIA_STORAGES }),
    // Cloudinary public id or Supabase object path; never shown to the panel.
    objectKey: text('object_key'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    // A document's name as the sender wrote it (Meta gives it in the webhook only).
    fileName: text('file_name'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    // Why the last attempt failed: a short reason, never a token or a URL.
    lastError: text('last_error'),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'message_media_pkey', columns: [t.tenantId, t.messageId] }),
    foreignKey({ name: 'message_media_message_fk', columns: [t.tenantId, t.messageId], foreignColumns: [messages.tenantId, messages.id] }).onDelete('cascade'),
    check('message_media_kind_check', oneOf(t.kind, CHAT_MEDIA_KINDS)),
    check('message_media_status_check', oneOf(t.status, CHAT_MEDIA_STATUSES)),
    check('message_media_storage_check', sql`${t.storage} is null or ${oneOf(t.storage, CHAT_MEDIA_STORAGES)}`),
    // A stored file always says where it is.
    check('message_media_stored_check', sql`${t.status} <> 'stored' or (${t.storage} is not null and ${t.objectKey} is not null)`),
    check('message_media_size_check', sql`${t.sizeBytes} is null or ${t.sizeBytes} >= 0`),
    check('message_media_file_name_check', sql`${t.fileName} is null or length(${t.fileName}) between 1 and 240`),
    // The archiver's queue: what is still waiting, oldest turn first.
    index('message_media_pending_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
  ],
)

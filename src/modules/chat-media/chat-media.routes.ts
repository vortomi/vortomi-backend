import { and, eq } from 'drizzle-orm'
import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { messageMedia, messages } from '../../db/schema/index.ts'
import { inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { ConversationNotFoundError } from '../conversations/conversation-commands.ts'
import type { ConversationQueries } from '../conversations/conversation-queries.ts'
import { type MediaStores, storeFor } from './media-archiver.ts'

export interface ChatMediaRoutesOptions {
  db: Database
  queries: Pick<ConversationQueries, 'get'>
  stores: MediaStores
}

/** The message has no stored file (not copied yet, too large, gone): same answer for all. */
export class MediaNotFoundError extends Error {
  constructor() {
    super('No stored file for that message')
    this.name = 'MediaNotFoundError'
  }
}

const params = z.object({ conversationId: z.uuid(), messageId: z.coerce.number().int().positive() })
const query = z.object({ size: z.enum(['thumb', 'full']).default('full') })

/** What a browser may show in place; any other document is only ever downloaded. */
const SHOWN_IN_PLACE = /^(image\/(jpeg|png|webp|gif)|audio\/(mpeg|ogg|mp4|aac|amr)|application\/pdf)$/

/**
 * GET /tenants/:tenantId/conversations/:conversationId/messages/:messageId/media: the file of a
 * message, for whoever may see that conversation (the same rule as its messages). The bytes come
 * through our server: the stores' addresses never reach the browser.
 */
export const chatMediaRoutes: FastifyPluginCallback<ChatMediaRoutesOptions> = (app, { db, queries, stores }, done) => {
  app.get('/:conversationId/messages/:messageId/media', async (request, reply) => {
    const { conversationId, messageId } = parseInput(params, request.params)
    const { size } = parseInput(query, request.query)
    // Checked in the company's scope; the store is read after, outside any transaction.
    const found = await inCompany(db, request, async (scope) => {
      if (!(await queries.get(scope, conversationId))) throw new ConversationNotFoundError()
      const [row] = await scope.tx
        .select({ kind: messageMedia.kind, status: messageMedia.status, objectKey: messageMedia.objectKey, fileName: messageMedia.fileName })
        .from(messageMedia)
        .innerJoin(messages, and(eq(messages.tenantId, messageMedia.tenantId), eq(messages.id, messageMedia.messageId)))
        .where(and(eq(messageMedia.tenantId, scope.tenantId), eq(messageMedia.messageId, messageId), eq(messages.conversationId, conversationId)))
      return row
    })
    const store = found ? stores[storeFor(found.kind)] : null
    if (!found || found.status !== 'stored' || !found.objectKey || !store) throw new MediaNotFoundError()

    const file = await store.get(found.objectKey, found.kind, size)
    const shown = SHOWN_IN_PLACE.test(file.mimeType)
    const name = encodeURIComponent(found.fileName ?? `archivo-${messageId}`)
    return reply
      .header('content-type', shown ? file.mimeType : 'application/octet-stream')
      .header('content-disposition', `${shown ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      // A stored copy never changes: the browser keeps it, so opening it again spends nothing.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      // Even if a file pretended to be a page, it could run nothing here.
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(file.bytes)
  })
  done()
}

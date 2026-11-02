import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../db/client.ts'
import { mediaFiles, orderReceipts, orders } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import type { InboundTrigger } from '../messaging/away-reply.ts'
import { type BotDelivery, type BotDraft, botMessageId, findTarget, storeBotText } from '../messaging/bot-delivery.ts'
import { withTenant } from '../tenancy/tenant-scope.ts'
import type { MediaDownloader } from '../whatsapp/cloud-api.client.ts'

/** What a payment receipt can come as. */
const RECEIPT_TYPES = new Set(['image', 'document'])

/** Says the receipt arrived, in the business's own voice (the order code stays internal). */
const ACKNOWLEDGEMENT = '¡Recibimos tu comprobante! Lo revisaremos y te confirmaremos en breve.'

/**
 * Payment receipts: an image or document the customer sends while an order of theirs waits for
 * payment is downloaded, kept with that order (status: payment to review) and acknowledged. Nobody
 * confirms the payment here: a person does, from «Pedidos».
 */
export class ReceiptCollector {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly downloader: MediaDownloader,
    private readonly delivery: BotDelivery,
    private readonly log: Pick<FastifyBaseLogger, 'error'>,
  ) {}

  /** Whether this message was a receipt for a pending order (then nothing else answers it). */
  async takes(tenantId: string, trigger: InboundTrigger): Promise<boolean> {
    if (!trigger.waMediaId || !trigger.type || !RECEIPT_TYPES.has(trigger.type)) return false
    const pending = await withTenant(this.db, tenantId, async ({ tx }) => {
      const [order] = await tx
        .select({ id: orders.id, code: orders.code, status: orders.status })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.conversationId, trigger.conversationId), inArray(orders.status, ['awaiting_payment', 'payment_review'])))
        .orderBy(desc(orders.createdAt))
        .limit(1)
      const target = order ? await findTarget(tx, tenantId, trigger.conversationId) : null
      return order && target ? { order, target } : null
    })
    if (!pending) return false

    let media: { bytes: Buffer; mimeType: string }
    try {
      const accessToken = await this.credentials.accessTokenFor(tenantId, pending.target.channelAccountId)
      if (!accessToken) throw new Error('No access token for the number')
      media = await this.downloader.downloadMedia(trigger.waMediaId, accessToken)
    } catch (error) {
      // The image stays in the chat; a person sees it there and the order stays as it was.
      this.log.error({ err: error, tenantId, orderId: pending.order.id }, 'Payment receipt could not be downloaded')
      return false
    }

    const draft = await withTenant(this.db, tenantId, async ({ tx }): Promise<BotDraft | null> => {
      await tx.insert(mediaFiles).values({ tenantId, waMediaId: trigger.waMediaId!, mimeType: media.mimeType, sizeBytes: media.bytes.length, content: media.bytes }).onConflictDoNothing()
      const [file] = await tx.select({ id: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.tenantId, tenantId), eq(mediaFiles.waMediaId, trigger.waMediaId!)))
      await tx.insert(orderReceipts).values({ tenantId, orderId: pending.order.id, mediaId: file!.id }).onConflictDoNothing()
      await tx
        .update(orders)
        .set({ status: 'payment_review', updatedAt: sql`now()` })
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, pending.order.id), eq(orders.status, 'awaiting_payment')))
      const body = ACKNOWLEDGEMENT
      const messageId = await storeBotText(tx, tenantId, trigger.conversationId, botMessageId('receipt', trigger.waMessageId), body)
      return messageId === null ? null : { messageId, ...pending.target, body }
    })
    if (draft) await this.delivery.deliver(tenantId, draft)
    return true
  }
}

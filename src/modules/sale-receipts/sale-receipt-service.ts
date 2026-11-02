import { and, desc, eq } from 'drizzle-orm'
import { exchangeRates, mediaFiles, paymentMethods, saleReceipts, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { type BotDelivery, type BotDraft, botMessageId, findTarget, storeBotText } from '../messaging/bot-delivery.ts'
import type { OrderDetail, OrderService } from '../orders/order-service.ts'
import { type PictureInput, readPicture } from './picture.ts'
import { receiptCode } from './receipt-defaults.ts'
import { type ReceiptData, renderReceipt } from './receipt-image.ts'
import type { ReceiptPrinting, ReceiptSettingsService } from './receipt-settings-service.ts'

/** Pictures of their own receipts the team uploads: the size WhatsApp takes for images. */
export const MAX_OWN_RECEIPT_BYTES = 5 * 1024 * 1024

/** The order already got its receipt: it is given once. */
export class ReceiptAlreadyIssuedError extends Error {
  constructor() {
    super('This order already has its receipt')
    this.name = 'ReceiptAlreadyIssuedError'
  }
}

/** A receipt that does not exist, or of an order the person does not see. */
export class SaleReceiptNotFoundError extends Error {
  constructor() {
    super('Sale receipt not found or not visible')
    this.name = 'SaleReceiptNotFoundError'
  }
}

/** What the customer reads with the picture, in the business's own voice. */
export const receiptCaption = (customerName: string) => `¡Gracias por tu compra, ${customerName.trim().split(/\s+/)[0]}! Aquí tienes tu recibo. 🧾`

/**
 * Sale receipts: when the company lets Vortomi make them, completing an order issues one (with the
 * next number) and sends it to the customer; with «Lo subo yo» the team uploads its own picture
 * and it is sent the same way. One per order, kept with it. Everything runs inside the person's
 * transaction; the message goes to Meta after it commits (send).
 */
export class SaleReceiptService {
  constructor(
    private readonly orders: OrderService,
    private readonly settings: ReceiptSettingsService,
    private readonly delivery: Pick<BotDelivery, 'deliver'>,
  ) {}

  /** On completing an order. Null when nothing is sent: receipts by the team or none, or given already. */
  async issueFor(scope: MemberScope, orderId: string): Promise<BotDraft | null> {
    if ((await this.settings.mode(scope)) !== 'vortomi') return null
    const order = await this.orders.detail(scope, orderId)
    if (order.saleReceipt) return null
    const printing = await this.settings.printing(scope)
    const number = await this.settings.takeNumber(scope)
    const code = receiptCode(printing.settings.prefix, number)
    const attendedBy = printing.settings.showAttendedBy ? await this.nameOf(scope, scope.member.userId) : null
    const png = renderReceipt(this.receiptData(order, printing, code, new Date(), attendedBy))
    return this.keepAndDraft(scope, order, { bytes: png, mimeType: 'image/png' }, { number, code }, `${code}.png`)
  }

  /** «Lo subo yo»: the team's own picture of the receipt, for an order already completed. */
  async attachOwn(scope: MemberScope, orderId: string, input: PictureInput): Promise<BotDraft | null> {
    const picture = readPicture(input, MAX_OWN_RECEIPT_BYTES)
    const order = await this.orders.detail(scope, orderId)
    if (order.saleReceipt) throw new ReceiptAlreadyIssuedError()
    return this.keepAndDraft(scope, order, picture, null, `recibo-${order.code}.${picture.mimeType === 'image/png' ? 'png' : 'jpg'}`)
  }

  /** The receipt's picture, only to whoever sees its order. */
  async file(scope: MemberScope, orderId: string): Promise<{ content: Buffer; mimeType: string }> {
    await this.orders.detail(scope, orderId).catch(() => {
      throw new SaleReceiptNotFoundError()
    })
    const [file] = await scope.tx
      .select({ content: mediaFiles.content, mimeType: mediaFiles.mimeType })
      .from(saleReceipts)
      .innerJoin(mediaFiles, and(eq(mediaFiles.tenantId, saleReceipts.tenantId), eq(mediaFiles.id, saleReceipts.mediaId)))
      .where(and(eq(saleReceipts.tenantId, scope.tenantId), eq(saleReceipts.orderId, orderId)))
    if (!file) throw new SaleReceiptNotFoundError()
    return file
  }

  /** How the company's receipts look now, with a sample sale: what «Ajustes → Recibo» shows. */
  async preview(scope: MemberScope): Promise<Buffer> {
    const printing = await this.settings.printing(scope)
    const [rate] = await scope.tx.select({ rate: exchangeRates.rate }).from(exchangeRates).where(eq(exchangeRates.tenantId, scope.tenantId)).orderBy(desc(exchangeRates.createdAt)).limit(1)
    const [method] = await scope.tx
      .select({ name: paymentMethods.name })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, scope.tenantId), eq(paymentMethods.isActive, true)))
      .orderBy(paymentMethods.sortOrder)
      .limit(1)
    const s = printing.settings
    return renderReceipt({
      business: { ...s.business, subtitle: s.subtitle, phone: s.phone },
      logo: printing.logo,
      code: s.nextCode,
      issuedAt: new Date(),
      timezone: printing.timezone,
      attendedBy: s.showAttendedBy ? await this.nameOf(scope, scope.member.userId) : null,
      customerName: 'Cliente de ejemplo',
      lines: [
        { name: 'Producto de ejemplo', quantity: 2, saleUnit: 'unit', unitPriceCents: 500 },
        { name: 'Otro producto', quantity: 1, saleUnit: 'unit', unitPriceCents: 1250 },
      ],
      fulfillment: 'delivery',
      deliveryCents: 200,
      bsPerUsd: rate ? Number(rate.rate).toFixed(2) : null,
      paymentMethod: method?.name ?? 'Pago móvil',
      paymentReference: s.showPaymentReference ? '123456' : null,
      footer: s.footer,
    })
  }

  /** After the transaction committed. Meta's errors stay on the message (never thrown). */
  send(tenantId: string, draft: BotDraft): Promise<void> {
    return this.delivery.deliver(tenantId, draft)
  }

  private receiptData(order: OrderDetail, printing: ReceiptPrinting, code: string, issuedAt: Date, attendedBy: string | null): ReceiptData {
    const s = printing.settings
    return {
      business: { ...s.business, subtitle: s.subtitle, phone: s.phone },
      logo: printing.logo,
      code,
      issuedAt,
      timezone: printing.timezone,
      attendedBy,
      customerName: order.customerName,
      lines: order.lines,
      fulfillment: order.fulfillment,
      deliveryCents: order.deliveryCents,
      bsPerUsd: order.bsPerUsd,
      paymentMethod: order.paymentMethod?.name ?? null,
      paymentReference: s.showPaymentReference ? order.paymentReference : null,
      footer: s.footer,
    }
  }

  /** Keeps the picture with the order and leaves the customer's message stored, ready to send. */
  private async keepAndDraft(
    scope: MemberScope,
    order: OrderDetail,
    picture: { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' },
    numbered: { number: number; code: string } | null,
    filename: string,
  ): Promise<BotDraft | null> {
    const { tx, tenantId } = scope
    const [file] = await tx
      .insert(mediaFiles)
      .values({ tenantId, mimeType: picture.mimeType, sizeBytes: picture.bytes.length, content: picture.bytes })
      .returning({ id: mediaFiles.id })
    await tx.insert(saleReceipts).values({ tenantId, orderId: order.id, number: numbered?.number ?? null, code: numbered?.code ?? null, mediaId: file!.id, issuedBy: scope.member.userId })
    const target = await findTarget(tx, tenantId, order.conversationId)
    if (!target) return null
    const caption = receiptCaption(order.customerName)
    const messageId = await storeBotText(tx, tenantId, order.conversationId, botMessageId('sale-receipt', order.id), caption, 'image')
    return messageId === null ? null : { messageId, ...target, body: caption, image: { ...picture, filename } }
  }

  private async nameOf(scope: MemberScope, userId: string): Promise<string | null> {
    const [user] = await scope.tx.select({ name: users.name }).from(users).where(eq(users.id, userId))
    return user?.name ?? null
  }
}

import type { MemberScope } from '../access/member-scope.ts'
import { type BotDelivery, type BotDraft, botMessageId, findTarget, storeBotText } from '../messaging/bot-delivery.ts'
import type { OrderService } from './order-service.ts'

/** What the customer reads when their order is confirmed, in the business's own voice (no order code). */
export const confirmationText = (customerName: string) =>
  `¡Listo, ${customerName.trim().split(/\s+/)[0]}! Tu pedido ha sido confirmado. Nos pondremos en contacto contigo ` +
  'para concretar el pedido y posteriormente la entrega. ¡Muchas gracias por confiar en nosotros! 😊'

/**
 * A person confirms an order (after reviewing its payment) and the customer is told by WhatsApp,
 * once: the message is stored in the person's transaction and sent after it.
 */
export class OrderConfirmation {
  constructor(
    private readonly orders: OrderService,
    private readonly delivery: Pick<BotDelivery, 'deliver'>,
  ) {}

  /** Inside the person's transaction. Null when there is nothing to send (already confirmed). */
  async confirm(scope: MemberScope, orderId: string): Promise<BotDraft | null> {
    const order = await this.orders.confirm(scope, orderId)
    if (!order) return null
    const target = await findTarget(scope.tx, scope.tenantId, order.conversationId)
    if (!target) return null
    const body = confirmationText(order.customerName)
    const messageId = await storeBotText(scope.tx, scope.tenantId, order.conversationId, botMessageId('order-confirmed', orderId), body)
    return messageId === null ? null : { messageId, ...target, body }
  }

  /** After the transaction committed. Meta's errors stay on the message (never thrown). */
  send(tenantId: string, draft: BotDraft): Promise<void> {
    return this.delivery.deliver(tenantId, draft)
  }
}

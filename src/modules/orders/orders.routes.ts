import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { ORDER_STATUSES } from '../../db/schema/enums.ts'
import { companyOf, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import type { SaleReceiptService } from '../sale-receipts/sale-receipt-service.ts'
import { type DailyCloseService, dailyCloseQuery } from './daily-close.ts'
import type { OrderConfirmation } from './order-confirmation.ts'
import { type OrderService, orderStatusInput } from './order-service.ts'
import { paymentCheckInput } from './payment-proof.ts'

export interface OrderRoutesOptions {
  db: Database
  orders: OrderService
  confirmation: OrderConfirmation
  saleReceipts: SaleReceiptService
  dailyClose: DailyCloseService
}

const listQuery = z.object({ status: z.enum(ORDER_STATUSES).optional(), conversationId: z.uuid().optional() })
const orderParams = z.object({ orderId: z.uuid() })
const receiptParams = z.object({ orderId: z.uuid(), mediaId: z.uuid() })

/** Shown in the panel as they are; anything else is only downloaded, never rendered by the browser. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

/** «Pedidos» and the order card of a chat: each person sees the orders of the conversations they see. */
export const orderRoutes: FastifyPluginCallback<OrderRoutesOptions> = (app, { db, orders, confirmation, saleReceipts, dailyClose }, done) => {
  app.get('/orders', (request) => inCompany(db, request, async (scope) => ({ items: await orders.list(scope, parseInput(listQuery, request.query)) })))
  // «Cierre del día»: declared before /orders/:orderId, which would not take it anyway (not a uuid).
  app.get('/orders/daily-close', (request) => inCompany(db, request, (scope) => dailyClose.close(scope, parseInput(dailyCloseQuery, request.query).date)))
  app.get('/orders/:orderId', (request) => inCompany(db, request, (scope) => orders.detail(scope, parseInput(orderParams, request.params).orderId)))
  app.get('/orders/:orderId/receipts/:mediaId', async (request, reply) => {
    const { orderId, mediaId } = parseInput(receiptParams, request.params)
    const file = await inCompany(db, request, (scope) => orders.receiptFile(scope, orderId, mediaId))
    const inline = INLINE_TYPES.has(file.mimeType)
    return reply
      .header('Content-Type', inline ? file.mimeType : 'application/octet-stream')
      .header('Content-Disposition', inline ? 'inline' : 'attachment')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.content)
  })
  // Completing an order gives the customer their receipt, when the company lets Vortomi make it.
  // The answer lists the products the inventory did not have enough of (the panel warns about them).
  app.put('/orders/:orderId/status', async (request) => {
    const { orderId } = parseInput(orderParams, request.params)
    const { status } = parseInput(orderStatusInput, request.body)
    const { outcome, draft } = await inCompany(db, request, async (scope) => {
      const outcome = await orders.setStatus(scope, orderId, status)
      return { outcome, draft: status === 'done' ? await saleReceipts.issueFor(scope, orderId) : null }
    })
    if (draft) await saleReceipts.send(companyOf(request).tenantId, draft)
    return outcome
  })
  app.put('/orders/:orderId/payment', async (request, reply) => {
    const { orderId } = parseInput(orderParams, request.params)
    await inCompany(db, request, (scope) => orders.setPayment(scope, orderId, parseInput(paymentCheckInput, request.body)))
    return reply.code(204).send()
  })
  app.post('/orders/:orderId/confirm', async (request) => {
    const { orderId } = parseInput(orderParams, request.params)
    const { draft, stockShortfalls } = await inCompany(db, request, (scope) => confirmation.confirm(scope, orderId))
    if (draft) await confirmation.send(companyOf(request).tenantId, draft)
    return { stockShortfalls }
  })
  done()
}

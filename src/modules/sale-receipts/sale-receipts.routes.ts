import type { FastifyPluginCallback, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin, companyOf, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { pictureInput } from './picture.ts'
import { MAX_LOGO_BYTES, type ReceiptSettingsService, logoInput, receiptSettingsInput } from './receipt-settings-service.ts'
import { MAX_OWN_RECEIPT_BYTES, type SaleReceiptService } from './sale-receipt-service.ts'

export interface SaleReceiptRoutesOptions {
  db: Database
  settings: ReceiptSettingsService
  receipts: SaleReceiptService
}

const orderParams = z.object({ orderId: z.uuid() })
const ownReceiptInput = pictureInput(MAX_OWN_RECEIPT_BYTES)
/** Base64 grows a file by a third; a little more for the JSON around it. */
const bodyLimitFor = (bytes: number) => Math.ceil((bytes * 4) / 3) + 4096

const sendPicture = (reply: FastifyReply, picture: { content: Buffer; mimeType: string }) =>
  reply.header('Content-Type', picture.mimeType).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(picture.content)

/**
 * «Ajustes → Recibo» (everyone in the company reads it; admins change it) and each order's sale
 * receipt: its picture, and the one the team uploads when it gives its own.
 */
export const saleReceiptRoutes: FastifyPluginCallback<SaleReceiptRoutesOptions> = (app, { db, settings, receipts }, done) => {
  app.get('/receipt-settings', (request) => inCompany(db, request, (scope) => settings.view(scope)))
  app.put('/receipt-settings', (request) => asAdmin(db, request, (scope) => settings.save(scope, parseInput(receiptSettingsInput, request.body))))
  app.put('/receipt-settings/logo', { bodyLimit: bodyLimitFor(MAX_LOGO_BYTES) }, (request) =>
    asAdmin(db, request, (scope) => settings.setLogo(scope, parseInput(logoInput, request.body))),
  )
  app.delete('/receipt-settings/logo', (request) => asAdmin(db, request, (scope) => settings.clearLogo(scope)))
  app.get('/receipt-settings/preview', async (request, reply) => {
    const png = await inCompany(db, request, (scope) => receipts.preview(scope))
    return sendPicture(reply, { content: png, mimeType: 'image/png' })
  })

  app.get('/orders/:orderId/sale-receipt', async (request, reply) => {
    const { orderId } = parseInput(orderParams, request.params)
    return sendPicture(reply, await inCompany(db, request, (scope) => receipts.file(scope, orderId)))
  })
  app.post('/orders/:orderId/sale-receipt', { bodyLimit: bodyLimitFor(MAX_OWN_RECEIPT_BYTES) }, async (request, reply) => {
    const { orderId } = parseInput(orderParams, request.params)
    const draft = await inCompany(db, request, (scope) => receipts.attachOwn(scope, orderId, parseInput(ownReceiptInput, request.body)))
    if (draft) await receipts.send(companyOf(request).tenantId, draft)
    return reply.code(204).send()
  })
  done()
}

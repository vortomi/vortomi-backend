import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { asAdmin, companyOf } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type SubscriptionService, assignPlanInput, choosePlanInput } from './subscription-service.ts'
import { type SubscriptionPaymentService, reportPaymentInput } from './subscription-payment-service.ts'
import { type SubscriptionReviewService, approvePaymentInput, receiptFile, rejectPaymentInput, reviewStatusQuery } from './subscription-review-service.ts'
import { walletBalance, walletMovementsOf } from './wallet.ts'
import { type ExemptionService, exemptionInput } from './subscription-exemptions.ts'
import { type SubscriptionSummaryService, summaryQuery } from './subscription-summary-service.ts'

const tenantParams = z.object({ tenantId: z.uuid() })
const paymentParams = z.object({ paymentId: z.uuid() })
const tenantPaymentParams = z.object({ tenantId: z.uuid(), paymentId: z.uuid() })
/** A receipt of up to 5 MB travels as base64 (a third larger), with the payment's data. */
const PAYMENT_BODY_LIMIT = 8 * 1024 * 1024
/** Shown in the panel as they are; never rendered as anything else. */
const INLINE_PROOF_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

export interface PlatformSubscriptionRoutesOptions {
  subscriptions: SubscriptionService
  review: SubscriptionReviewService
  exemptions: ExemptionService
  summary: SubscriptionSummaryService
}

/** A file of ours: inline when the browser can show it, downloaded otherwise; never anything else. */
function sendFile(reply: FastifyReply, bytes: Uint8Array | Buffer, mimeType: string, fileName?: string) {
  const inline = INLINE_PROOF_TYPES.has(mimeType)
  return reply
    .header('Content-Type', inline ? mimeType : 'application/octet-stream')
    .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}${fileName ? `; filename="${fileName}"` : ''}`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(Buffer.from(bytes))
}

/**
 * The console's side (mockup web-37): Suscripciones → Cobros, and a company's subscription on its
 * page, where a plan is assigned. Registered inside platformRoutes: its guard runs first.
 */
export const platformSubscriptionRoutes: FastifyPluginCallback<PlatformSubscriptionRoutesOptions> = (app, { subscriptions, review, exemptions, summary }, done) => {
  app.get('/subscriptions', async () => ({ items: await subscriptions.list() }))
  // Suscripciones → Resumen (mockup web-51): income, what is owed, how companies pay; and the file.
  app.get('/subscriptions/summary', async (request) => summary.summary(parseInput(summaryQuery, request.query).period))
  app.get('/subscriptions/income.csv', async (request, reply) => {
    const { period } = parseInput(summaryQuery, request.query)
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="ingresos-vortomi-${period}.csv"`)
      .header('Cache-Control', 'private, no-store')
      .send(await summary.incomeCsv(period))
  })
  app.get('/tenants/:tenantId/subscription/history', async (request) => summary.history(parseInput(tenantParams, request.params).tenantId))
  app.get('/tenants/:tenantId/subscription', async (request) => ({
    subscription: await subscriptions.view(parseInput(tenantParams, request.params).tenantId),
  }))
  app.post('/tenants/:tenantId/subscription', async (request, reply) => {
    const { tenantId } = parseInput(tenantParams, request.params)
    const { planId } = parseInput(assignPlanInput, request.body)
    return reply.code(201).send({ subscription: await subscriptions.assign(tenantId, planId, identityOf(request).userId) })
  })

  // «Exonerar del pago» (mockup web-49): granted, changed, and ended in 7 days. Each one is a route
  // of its own, so «Actividad en la consola» names what was done.
  app.get('/tenants/:tenantId/exemption', async (request) => ({ exemption: await exemptions.view(parseInput(tenantParams, request.params).tenantId) }))
  app.post('/tenants/:tenantId/exemption', async (request, reply) => {
    const { tenantId } = parseInput(tenantParams, request.params)
    const input = parseInput(exemptionInput, request.body)
    return reply.code(201).send({ exemption: await exemptions.grant(tenantId, input, identityOf(request).userId) })
  })
  app.put('/tenants/:tenantId/exemption', async (request) => {
    const { tenantId } = parseInput(tenantParams, request.params)
    return { exemption: await exemptions.change(tenantId, parseInput(exemptionInput, request.body)) }
  })
  app.delete('/tenants/:tenantId/exemption', async (request) => ({ exemption: await exemptions.remove(parseInput(tenantParams, request.params).tenantId) }))

  // Suscripciones → Pagos (mockup web-41): the payments companies report, reviewed here.
  app.get('/subscription-payments', async (request) => ({ items: await review.list(parseInput(reviewStatusQuery, request.query).status) }))
  app.get('/subscription-payments/pending-count', async () => ({ count: await review.pendingCount() }))
  app.get('/subscription-payments/:paymentId', async (request) => ({ payment: await review.detail(parseInput(paymentParams, request.params).paymentId) }))
  // Approving and rejecting name the company in the address: «Actividad en la consola» records it.
  app.get('/tenants/:tenantId/subscription-payments/:paymentId/proof', async (request, reply) => {
    const { tenantId, paymentId } = parseInput(tenantPaymentParams, request.params)
    const file = await review.proof(tenantId, paymentId)
    return sendFile(reply, file.bytes, file.mimeType)
  })
  app.post('/tenants/:tenantId/subscription-payments/:paymentId/approve', async (request) => {
    const { tenantId, paymentId } = parseInput(tenantPaymentParams, request.params)
    const { receivedAmount } = parseInput(approvePaymentInput, request.body ?? {})
    return { payment: await review.approve(tenantId, paymentId, identityOf(request).userId, receivedAmount) }
  })
  app.post('/tenants/:tenantId/subscription-payments/:paymentId/reject', async (request) => {
    const { tenantId, paymentId } = parseInput(tenantPaymentParams, request.params)
    const { reason, note } = parseInput(rejectPaymentInput, request.body)
    return { payment: await review.reject(tenantId, paymentId, identityOf(request).userId, reason, note) }
  })
  app.get('/tenants/:tenantId/subscription-payments/:paymentId/receipt', async (request, reply) => {
    const { tenantId, paymentId } = parseInput(tenantPaymentParams, request.params)
    const file = await review.receipt(tenantId, paymentId)
    return sendFile(reply, file.bytes, 'application/pdf', file.fileName)
  })
  done()
}

export interface CompanySubscriptionRoutesOptions {
  db: Database
  subscriptions: SubscriptionService
  payments: SubscriptionPaymentService
}

/**
 * /tenants/:tenantId/subscription: the company's own Suscripción, for its owner and admins (mockup
 * web-38). It reads its plan or its trial, and chooses its plan itself. It stays open while the
 * company is suspended ('billing' stage): it is where it chooses and pays.
 */
export const companySubscriptionRoutes: FastifyPluginCallback<CompanySubscriptionRoutesOptions> = (app, { db, subscriptions, payments }, done) => {
  const asOwnerOrAdmin = (request: FastifyRequest) => asAdmin(db, request, () => Promise.resolve(), 'billing')
  app.get('/subscription', async (request) => {
    await asAdmin(db, request, () => Promise.resolve(), 'billing')
    return subscriptions.companyView(companyOf(request).tenantId)
  })
  // The membership is proven first; the subscription is then written as the platform (a company
  // never writes these tables itself: migration 0076).
  app.post('/subscription', async (request, reply) => {
    const { planId, months } = parseInput(choosePlanInput, request.body)
    await asAdmin(db, request, () => Promise.resolve(), 'billing')
    const subscription = await subscriptions.assign(companyOf(request).tenantId, planId, identityOf(request).userId, { months, origin: 'company' })
    return reply.code(201).send({ subscription })
  })

  // Its payments to Vortomi (documentations/18 §5; mockups web-39 and web-40).
  app.get('/subscription/methods', async (request) => {
    await asOwnerOrAdmin(request)
    return { items: await payments.methods() }
  })
  app.get('/subscription/payments', async (request) => {
    await asOwnerOrAdmin(request)
    return { items: await payments.list(companyOf(request).tenantId) }
  })
  app.post('/subscription/payments', { bodyLimit: PAYMENT_BODY_LIMIT }, async (request, reply) => {
    const input = parseInput(reportPaymentInput, request.body)
    await asOwnerOrAdmin(request)
    return reply.code(201).send({ payment: await payments.report(companyOf(request).tenantId, identityOf(request).userId, input) })
  })
  // Only a rejected payment, corrected and sent again.
  app.put('/subscription/payments/:paymentId', { bodyLimit: PAYMENT_BODY_LIMIT }, async (request) => {
    const { paymentId } = parseInput(paymentParams, request.params)
    const input = parseInput(reportPaymentInput, request.body)
    await asOwnerOrAdmin(request)
    return { payment: await payments.resubmit(companyOf(request).tenantId, paymentId, identityOf(request).userId, input) }
  })
  app.get('/subscription/payments/:paymentId/proof', async (request, reply) => {
    const { paymentId } = parseInput(paymentParams, request.params)
    await asOwnerOrAdmin(request)
    const file = await payments.proof(companyOf(request).tenantId, paymentId)
    return sendFile(reply, file.bytes, file.mimeType)
  })
  // The receipt of an approved payment, and the balance in favour with its movements (mockup web-41).
  app.get('/subscription/payments/:paymentId/receipt', async (request, reply) => {
    const { paymentId } = parseInput(paymentParams, request.params)
    await asOwnerOrAdmin(request)
    const file = await receiptFile(db, companyOf(request).tenantId, paymentId)
    return sendFile(reply, file.bytes, 'application/pdf', file.fileName)
  })
  app.get('/subscription/wallet', async (request) => {
    await asOwnerOrAdmin(request)
    const tenantId = companyOf(request).tenantId
    return { balanceCents: await walletBalance(db, tenantId), movements: await walletMovementsOf(db, tenantId) }
  })
  done()
}

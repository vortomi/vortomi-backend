import type { FastifyPluginCallback, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { asAdmin, companyOf } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type SubscriptionService, assignPlanInput, choosePlanInput } from './subscription-service.ts'
import { type SubscriptionPaymentService, reportPaymentInput } from './subscription-payment-service.ts'

const tenantParams = z.object({ tenantId: z.uuid() })
const paymentParams = z.object({ paymentId: z.uuid() })
/** A receipt of up to 5 MB travels as base64 (a third larger), with the payment's data. */
const PAYMENT_BODY_LIMIT = 8 * 1024 * 1024
/** Shown in the panel as they are; never rendered as anything else. */
const INLINE_PROOF_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

export interface PlatformSubscriptionRoutesOptions {
  subscriptions: SubscriptionService
}

/**
 * The console's side (mockup web-37): Suscripciones → Cobros, and a company's subscription on its
 * page, where a plan is assigned. Registered inside platformRoutes: its guard runs first.
 */
export const platformSubscriptionRoutes: FastifyPluginCallback<PlatformSubscriptionRoutesOptions> = (app, { subscriptions }, done) => {
  app.get('/subscriptions', async () => ({ items: await subscriptions.list() }))
  app.get('/tenants/:tenantId/subscription', async (request) => ({
    subscription: await subscriptions.view(parseInput(tenantParams, request.params).tenantId),
  }))
  app.post('/tenants/:tenantId/subscription', async (request, reply) => {
    const { tenantId } = parseInput(tenantParams, request.params)
    const { planId } = parseInput(assignPlanInput, request.body)
    return reply.code(201).send({ subscription: await subscriptions.assign(tenantId, planId, identityOf(request).userId) })
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
    const inline = INLINE_PROOF_TYPES.has(file.mimeType)
    return reply
      .header('Content-Type', inline ? file.mimeType : 'application/octet-stream')
      .header('Content-Disposition', inline ? 'inline' : 'attachment')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.bytes)
  })
  done()
}

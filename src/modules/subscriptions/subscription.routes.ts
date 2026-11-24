import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { asAdmin, companyOf } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type SubscriptionService, assignPlanInput } from './subscription-service.ts'

const tenantParams = z.object({ tenantId: z.uuid() })

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
}

/**
 * /tenants/:tenantId/subscription: the company's own Suscripción, for its owner and admins. It stays
 * open while the company is suspended for not paying ('billing' stage): it is where it pays.
 */
export const companySubscriptionRoutes: FastifyPluginCallback<CompanySubscriptionRoutesOptions> = (app, { db, subscriptions }, done) => {
  app.get('/subscription', async (request) => {
    await asAdmin(db, request, () => Promise.resolve(), 'billing')
    return { subscription: await subscriptions.view(companyOf(request).tenantId) }
  })
  done()
}

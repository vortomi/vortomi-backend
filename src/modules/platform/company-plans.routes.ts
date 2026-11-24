import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import type { PlatformPlanService } from './platform-plans.ts'

export interface CompanyPlanRoutesOptions {
  db: Database
  plans: PlatformPlanService
}

/**
 * /tenants/:tenantId/plans: Vortomi's active plans, for the company's Suscripción → Planes (mockup
 * web-35). Only the company's admins (owner included) read them. The plans are Vortomi's own data,
 * never readable from a company's scope: the membership is proven first, then the service reads
 * them with its own connection.
 */
export const companyPlanRoutes: FastifyPluginCallback<CompanyPlanRoutesOptions> = (app, { db, plans }, done) => {
  app.get('/plans', async (request) => {
    // Part of Suscripción: open while the company is suspended for not paying.
    await asAdmin(db, request, () => Promise.resolve(), 'billing')
    return { items: await plans.listActive() }
  })
  done()
}

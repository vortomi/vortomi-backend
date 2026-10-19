import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type UsageService, monthParam } from './usage-service.ts'

export interface UsageRoutesOptions {
  db: Database
  usage: UsageService
}

const usageQuery = z.object({ month: monthParam })

/** /tenants/:tenantId/usage?month=YYYY-MM: the company's Meta usage per number (reports are admin-only). */
export const usageRoutes: FastifyPluginCallback<UsageRoutesOptions> = (app, { db, usage }, done) => {
  app.get('/usage', (request) =>
    asAdmin(db, request, async (scope) => ({ items: await usage.monthly(scope.tx, parseInput(usageQuery, request.query).month, scope.tenantId) })),
  )
  done()
}

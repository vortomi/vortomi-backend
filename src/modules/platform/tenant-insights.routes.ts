import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../../http/validation.ts'
import { TenantNotFoundError } from './tenant-admin-service.ts'
import type { TenantInsightService } from './tenant-insights.ts'

const tenantParams = z.object({ tenantId: z.uuid() })

/**
 * The console's figures about companies (mockup web-25). Registered inside the platform routes,
 * so the same guard applies: super admin with the second factor.
 *   GET /platform/tenants/insights            every company, for the list
 *   GET /platform/tenants/:tenantId/insights  one company, for its page
 */
export const tenantInsightRoutes: FastifyPluginCallback<{ insights: TenantInsightService }> = (app, { insights }, done) => {
  app.get('/tenants/insights', () => insights.list())
  app.get('/tenants/:tenantId/insights', async (request) => {
    const detail = await insights.detail(parseInput(tenantParams, request.params).tenantId)
    if (!detail) throw new TenantNotFoundError()
    return detail
  })
  done()
}

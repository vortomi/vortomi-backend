import type { FastifyPluginCallback } from 'fastify'
import { identityOf } from '../../http/authenticate.ts'
import { forbidden } from '../../http/errors.ts'
import type { AccessDirectory } from '../access/access-directory.ts'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { parseInput } from '../../http/validation.ts'
import { type UsageService, monthParam } from '../usage/usage-service.ts'
import type { TenantCatalog } from './tenant-catalog.ts'

export interface PlatformRoutesOptions {
  directory: AccessDirectory
  catalog: TenantCatalog
  db: Database
  usage: UsageService
}

/**
 * Platform console (our own team). Every route requires the super_admin role AND a
 * session signed in with the second factor (documentations/04, D12): this console
 * reaches every company, so a stolen password alone must not open it.
 */
export const platformRoutes: FastifyPluginCallback<PlatformRoutesOptions> = (app, { directory, catalog, db, usage }, done) => {
  app.addHook('preHandler', async (request) => {
    const identity = identityOf(request)
    const account = await directory.findAccount(identity.userId)
    if (account?.platformRole !== 'super_admin') throw forbidden('platform_admin_required')
    if (!identity.secondFactor) throw forbidden('second_factor_required')
  })

  app.get('/tenants', async () => ({ tenants: await catalog.list() }))

  // Counts per company and number, never content: what billing and health need.
  app.get('/usage', async (request) => ({ items: await usage.monthly(db, parseInput(z.object({ month: monthParam }), request.query).month) }))

  done()
}

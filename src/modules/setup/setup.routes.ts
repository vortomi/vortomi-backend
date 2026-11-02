import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import type { BusinessTypeService } from './business-type-service.ts'
import { type SetupService, answersInput, applyInput } from './setup-service.ts'

export interface SetupRoutesOptions {
  db: Database
  setup: SetupService
}

/**
 * /tenants/:tenantId/setup: the welcome. Everyone in the company reads its answers (the panel
 * decides whether to open it); answering, preparing and skipping are for admins.
 */
export const setupRoutes: FastifyPluginCallback<SetupRoutesOptions> = (app, { db, setup }, done) => {
  app.get('/setup', (request) => inCompany(db, request, (scope) => setup.status(scope)))
  app.post('/setup/plan', (request) => asAdmin(db, request, (scope) => setup.plan(scope, parseInput(answersInput, request.body))))
  app.post('/setup/apply', (request) => asAdmin(db, request, (scope) => setup.apply(scope, parseInput(applyInput, request.body))))
  app.post('/setup/skip', (request) => asAdmin(db, request, (scope) => setup.skip(scope)))
  done()
}

/** /business-types: the platform's closed list, for anyone signed in (the welcome and the console show it). */
export const businessTypeRoutes: FastifyPluginCallback<{ types: BusinessTypeService }> = (app, { types }, done) => {
  app.get('/business-types', async () => ({ items: await types.list() }))
  done()
}

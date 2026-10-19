import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { inCompany } from '../../http/company-scope.ts'
import type { TeamService } from './team-service.ts'

export interface TeamRoutesOptions {
  db: Database
  team: TeamService
}

/** /tenants/:tenantId/team: who works here (assignment list, team screen). */
export const teamRoutes: FastifyPluginCallback<TeamRoutesOptions> = (app, { db, team }, done) => {
  app.get('/team', (request) => inCompany(db, request, async (scope) => ({ items: await team.list(scope) })))
  done()
}

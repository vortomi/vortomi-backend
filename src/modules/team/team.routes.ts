import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { inCompany } from '../../http/company-scope.ts'
import { listChannels } from './channel-list.ts'
import type { TeamService } from './team-service.ts'

export interface TeamRoutesOptions {
  db: Database
  team: TeamService
}

/** /tenants/:tenantId/team and /channels: who works here and on which numbers. */
export const teamRoutes: FastifyPluginCallback<TeamRoutesOptions> = (app, { db, team }, done) => {
  app.get('/team', (request) => inCompany(db, request, async (scope) => ({ items: await team.list(scope) })))
  app.get('/channels', (request) => inCompany(db, request, async (scope) => ({ items: await listChannels(scope) })))
  done()
}

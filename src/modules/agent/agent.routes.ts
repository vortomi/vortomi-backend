import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type AgentSettingsService, agentSettingsInput } from './agent-settings-service.ts'

export interface AgentRoutesOptions {
  db: Database
  settings: AgentSettingsService
}

/** «Ajustes → Agente»: turning the sales agent on or off and how it speaks. Admins only. */
export const agentRoutes: FastifyPluginCallback<AgentRoutesOptions> = (app, { db, settings }, done) => {
  app.get('/agent', (request) => asAdmin(db, request, (scope) => settings.view(scope)))
  app.put('/agent', (request) => asAdmin(db, request, (scope) => settings.save(scope, parseInput(agentSettingsInput, request.body))))
  done()
}

import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { companyOf, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type TemplateService, templateInput } from './template-service.ts'

export interface TemplateRoutesOptions {
  db: Database
  templates: TemplateService
}

/** /tenants/:tenantId/templates. Everyone sees them; admins submit new ones to Meta. */
export const templateRoutes: FastifyPluginCallback<TemplateRoutesOptions> = (app, { db, templates }, done) => {
  app.get('/templates', (request) => inCompany(db, request, async (scope) => ({ items: await templates.list(scope) })))

  // Outside inCompany: the service keeps the call to Meta out of any transaction.
  app.post('/templates', async (request, reply) => {
    const { tenantId, userId } = companyOf(request)
    const template = await templates.submit(tenantId, userId, parseInput(templateInput, request.body))
    return reply.code(201).send(template)
  })

  done()
}

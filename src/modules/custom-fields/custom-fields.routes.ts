import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type CustomFieldService, entityQuery, fieldInput, fieldUpdate } from './custom-field-service.ts'

export interface CustomFieldRoutesOptions {
  db: Database
  fields: CustomFieldService
}

const fieldParams = z.object({ fieldId: z.uuid() })
const organizeBody = z.object({ label: z.string().trim().min(1).max(80) })

/**
 * /tenants/:tenantId/custom-fields: the company's own data about its products and customers.
 * Everyone reads the fields (every form shows them); defining them is for admins.
 */
export const customFieldRoutes: FastifyPluginCallback<CustomFieldRoutesOptions> = (app, { db, fields }, done) => {
  app.get('/custom-fields', (request) =>
    inCompany(db, request, async (scope) => ({ items: await fields.list(scope, parseInput(entityQuery, request.query).entity) })),
  )

  app.post('/custom-fields', async (request, reply) =>
    reply.code(201).send(await asAdmin(db, request, (scope) => fields.create(scope, parseInput(fieldInput, request.body)))),
  )

  app.put('/custom-fields/:fieldId', (request) =>
    asAdmin(db, request, (scope) => fields.update(scope, parseInput(fieldParams, request.params).fieldId, parseInput(fieldUpdate, request.body))),
  )

  app.delete('/custom-fields/:fieldId', async (request, reply) => {
    await asAdmin(db, request, (scope) => fields.remove(scope, parseInput(fieldParams, request.params).fieldId))
    return reply.code(204).send()
  })

  // Notes typed on contacts before the company had fields, and turning them into one.
  app.get('/custom-fields/notes', (request) => asAdmin(db, request, async (scope) => ({ items: await fields.notes(scope) })))

  app.post('/custom-fields/notes/organize', (request) =>
    asAdmin(db, request, (scope) => fields.organizeNotes(scope, parseInput(organizeBody, request.body).label)),
  )

  done()
}

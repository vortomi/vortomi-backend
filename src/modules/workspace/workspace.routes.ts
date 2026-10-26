import type { FastifyPluginCallback, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { asAdmin as asAdminIn, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type PipelineService, opportunityInput, stageInput } from './pipeline-service.ts'
import { type QuickReplyService, quickReplyInput } from './quick-reply-service.ts'
import { type SettingsService, profileInput, settingsInput } from './settings-service.ts'

export interface WorkspaceRoutesOptions {
  db: Database
  settings: SettingsService
  quickReplies: QuickReplyService
  pipeline: PipelineService
}

const idParams = z.object({ id: z.uuid() })
const contactParams = z.object({ contactId: z.uuid() })
const reorderBody = z.object({ stageIds: z.array(z.uuid()).max(30) })

/**
 * /tenants/:tenantId/settings, /quick-replies, /pipeline/stages, /contacts/:id/opportunity.
 * Everyone in the company reads; changing how the company works is for admins.
 */
export const workspaceRoutes: FastifyPluginCallback<WorkspaceRoutesOptions> = (app, { db, settings, quickReplies, pipeline }, done) => {
  const asAdmin: <T>(request: FastifyRequest, work: (scope: MemberScope) => Promise<T>) => Promise<T> = (request, work) => asAdminIn(db, request, work)

  app.get('/settings', (request) => inCompany(db, request, (scope) => settings.get(scope)))
  app.put('/settings', (request) => asAdmin(request, (scope) => settings.save(scope, parseInput(settingsInput, request.body))))
  app.put('/profile', (request) => asAdmin(request, (scope) => settings.saveProfile(scope, parseInput(profileInput, request.body))))

  app.get('/quick-replies', (request) => inCompany(db, request, async (scope) => ({ items: await quickReplies.list(scope) })))
  app.post('/quick-replies', async (request, reply) =>
    reply.code(201).send(await asAdmin(request, (scope) => quickReplies.create(scope, parseInput(quickReplyInput, request.body)))),
  )
  app.put('/quick-replies/:id', (request) =>
    asAdmin(request, (scope) => quickReplies.update(scope, parseInput(idParams, request.params).id, parseInput(quickReplyInput, request.body))),
  )
  app.delete('/quick-replies/:id', async (request, reply) => {
    await asAdmin(request, (scope) => quickReplies.remove(scope, parseInput(idParams, request.params).id))
    return reply.code(204).send()
  })

  app.get('/pipeline/stages', (request) => inCompany(db, request, async (scope) => ({ items: await pipeline.stages(scope) })))
  app.post('/pipeline/stages', async (request, reply) =>
    reply.code(201).send(await asAdmin(request, (scope) => pipeline.create(scope, parseInput(stageInput, request.body)))),
  )
  app.put('/pipeline/stages/:id', (request) =>
    asAdmin(request, (scope) => pipeline.update(scope, parseInput(idParams, request.params).id, parseInput(stageInput, request.body))),
  )
  app.delete('/pipeline/stages/:id', async (request, reply) => {
    await asAdmin(request, (scope) => pipeline.remove(scope, parseInput(idParams, request.params).id))
    return reply.code(204).send()
  })
  app.put('/pipeline/order', (request) =>
    asAdmin(request, async (scope) => ({ items: await pipeline.reorder(scope, parseInput(reorderBody, request.body).stageIds) })),
  )

  // Anyone who sees the contact moves it along the pipeline.
  app.put('/contacts/:contactId/opportunity', async (request, reply) => {
    await inCompany(db, request, (scope) =>
      pipeline.setOpportunity(scope, parseInput(contactParams, request.params).contactId, parseInput(opportunityInput, request.body)),
    )
    return reply.code(204).send()
  })

  done()
}

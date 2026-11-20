import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../../http/validation.ts'
import { type PlatformPlanService, newPlanInput, planActiveInput, planInput } from './platform-plans.ts'

export interface PlatformPlanRoutesOptions {
  plans: PlatformPlanService
}

const planParams = z.object({ planId: z.uuid() })

/**
 * /platform/plans (mockup web-34): create, edit, suspend and delete Vortomi's plans. Registered
 * inside platformRoutes, so its guard (super admin with the second factor) runs first on every one.
 */
export const platformPlanRoutes: FastifyPluginCallback<PlatformPlanRoutesOptions> = (app, { plans }, done) => {
  const id = (params: unknown) => parseInput(planParams, params).planId

  app.get('/plans', async () => ({ items: await plans.list() }))
  app.post('/plans', async (request, reply) => reply.code(201).send(await plans.create(parseInput(newPlanInput, request.body))))
  app.put('/plans/:planId', (request) => plans.update(id(request.params), parseInput(planInput, request.body)))
  app.put('/plans/:planId/active', (request) => plans.setActive(id(request.params), parseInput(planActiveInput, request.body).isActive))
  app.delete('/plans/:planId', async (request, reply) => {
    await plans.remove(id(request.params))
    return reply.code(204).send()
  })
  done()
}

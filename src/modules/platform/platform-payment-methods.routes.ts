import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import { parseInput } from '../../http/validation.ts'
import { paymentMethodInput, paymentMethodOrderInput } from '../payment-methods/payment-method-service.ts'
import type { PlatformPaymentMethodService } from './platform-payment-methods.ts'

export interface PlatformPaymentMethodRoutesOptions {
  methods: PlatformPaymentMethodService
}

const methodParams = z.object({ methodId: z.uuid() })

/**
 * /platform/payment-methods: where companies pay Vortomi. Registered inside platformRoutes, so its
 * guard (super admin with the second factor) runs first on every one of these.
 */
export const platformPaymentMethodRoutes: FastifyPluginCallback<PlatformPaymentMethodRoutesOptions> = (app, { methods }, done) => {
  app.get('/payment-methods', async () => ({ items: await methods.list() }))
  app.post('/payment-methods', async (request, reply) => reply.code(201).send(await methods.create(parseInput(paymentMethodInput, request.body))))
  // Before /:methodId, so "order" is never read as an id.
  app.put('/payment-methods/order', async (request) => ({ items: await methods.reorder(parseInput(paymentMethodOrderInput, request.body).ids) }))
  app.put('/payment-methods/:methodId', (request) =>
    methods.update(parseInput(methodParams, request.params).methodId, parseInput(paymentMethodInput, request.body)),
  )
  done()
}

import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type PaymentMethodService, paymentMethodInput, paymentMethodOrderInput } from './payment-method-service.ts'

export interface PaymentMethodRoutesOptions {
  db: Database
  methods: PaymentMethodService
}

const methodParams = z.object({ methodId: z.uuid() })

/** «Métodos de pago»: anyone in the company reads them (to answer customers); admins change them. */
export const paymentMethodRoutes: FastifyPluginCallback<PaymentMethodRoutesOptions> = (app, { db, methods }, done) => {
  app.get('/payment-methods', (request) => inCompany(db, request, async (scope) => ({ items: await methods.list(scope) })))
  app.post('/payment-methods', async (request, reply) => {
    const created = await asAdmin(db, request, (scope) => methods.create(scope, parseInput(paymentMethodInput, request.body)))
    return reply.code(201).send(created)
  })
  // Before /:methodId, so "order" is never read as an id.
  app.put('/payment-methods/order', (request) =>
    asAdmin(db, request, async (scope) => ({ items: await methods.reorder(scope, parseInput(paymentMethodOrderInput, request.body).ids) })),
  )
  app.put('/payment-methods/:methodId', (request) =>
    asAdmin(db, request, (scope) => methods.update(scope, parseInput(methodParams, request.params).methodId, parseInput(paymentMethodInput, request.body))),
  )
  done()
}

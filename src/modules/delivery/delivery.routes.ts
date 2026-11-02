import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type DeliveryService, deliveryInput } from './delivery-service.ts'

export interface DeliveryRoutesOptions {
  db: Database
  delivery: DeliveryService
}

/** «Ajustes → Delivery»: anyone in the company reads it (to answer customers); admins change it. */
export const deliveryRoutes: FastifyPluginCallback<DeliveryRoutesOptions> = (app, { db, delivery }, done) => {
  app.get('/delivery', (request) => inCompany(db, request, (scope) => delivery.view(scope)))
  app.put('/delivery', (request) => asAdmin(db, request, (scope) => delivery.save(scope, parseInput(deliveryInput, request.body))))
  done()
}

import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import type { BcvRateService } from './bcv-rate.service.ts'
import { type ExchangeRateService, manualRateInput, rateSourceInput } from './exchange-rate-service.ts'

export interface ExchangeRateRoutesOptions {
  db: Database
  rates: ExchangeRateService
  bcv: Pick<BcvRateService, 'refresh'>
}

/**
 * /tenants/:tenantId/exchange-rates. Everyone in the company reads it (prices in bolívares);
 * changing it is for admins. Every answer is the whole card, as the panel shows it.
 */
export const exchangeRateRoutes: FastifyPluginCallback<ExchangeRateRoutesOptions> = (app, { db, rates, bcv }, done) => {
  app.get('/exchange-rates', (request) => inCompany(db, request, (scope) => rates.view(scope)))

  // Switching to the BCV reads it before answering, so the card shows its rate right away.
  app.put('/exchange-rates/source', async (request) => {
    const { rateSource } = parseInput(rateSourceInput, request.body)
    await asAdmin(db, request, (scope) => rates.setSource(scope, rateSource))
    if (rateSource === 'bcv') await bcv.refresh()
    return inCompany(db, request, (scope) => rates.view(scope))
  })

  // "Actualizar ahora": with a typed rate there is nothing to read.
  app.post('/exchange-rates/bcv', async (request) => {
    const source = await asAdmin(db, request, (scope) => rates.rateSource(scope))
    if (source === 'bcv') await bcv.refresh()
    return inCompany(db, request, (scope) => rates.view(scope))
  })

  app.post('/exchange-rates', async (request, reply) => {
    const input = parseInput(manualRateInput, request.body)
    const view = await asAdmin(db, request, async (scope) => {
      await rates.addManual(scope, input)
      return rates.view(scope)
    })
    return reply.code(201).send(view)
  })

  done()
}

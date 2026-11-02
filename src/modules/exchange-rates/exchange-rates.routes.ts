import type { FastifyPluginCallback, FastifyRequest } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin, companyOf, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import type { CatalogSources } from '../catalog-source/catalog-sources.ts'
import type { BcvRateService } from './bcv-rate.service.ts'
import { type ExchangeRateService, type ExchangeRateView, manualRateInput, rateSourceInput, systemRateInput } from './exchange-rate-service.ts'

export interface ExchangeRateRoutesOptions {
  db: Database
  rates: ExchangeRateService
  bcv: Pick<BcvRateService, 'refresh'>
  /** Companies with their own catalog system, whose rate the card shows; none without it. */
  catalogs?: Pick<CatalogSources, 'systemRate'>
}

/**
 * /tenants/:tenantId/exchange-rates. Everyone in the company reads it (prices in bolívares);
 * changing it is for admins. Every answer is the whole card, as the panel shows it.
 */
export const exchangeRateRoutes: FastifyPluginCallback<ExchangeRateRoutesOptions> = (app, { db, rates, bcv, catalogs }, done) => {
  /**
   * The card. The company's own system is read after the membership check (an outsider never
   * makes us call it) and outside any transaction (the read can take seconds).
   */
  const card = async (request: FastifyRequest): Promise<ExchangeRateView> => {
    const view = await inCompany(db, request, (scope) => rates.view(scope))
    const systemRate = (await catalogs?.systemRate(companyOf(request).tenantId)) ?? null
    return systemRate ? inCompany(db, request, (scope) => rates.view(scope, systemRate)) : view
  }

  app.get('/exchange-rates', (request) => card(request))

  // Switching to the BCV reads it before answering, so the card shows its rate right away.
  app.put('/exchange-rates/source', async (request) => {
    const { rateSource } = parseInput(rateSourceInput, request.body)
    await asAdmin(db, request, (scope) => rates.setSource(scope, rateSource))
    if (rateSource === 'bcv') await bcv.refresh()
    return card(request)
  })

  // «Usar la tasa de mi sistema»: only means something for a company with its own system.
  app.put('/exchange-rates/system', async (request) => {
    const { useSystemRate } = parseInput(systemRateInput, request.body)
    await asAdmin(db, request, (scope) => rates.setUseSystemRate(scope, useSystemRate))
    return card(request)
  })

  // "Actualizar ahora": with a typed rate there is nothing to read.
  app.post('/exchange-rates/bcv', async (request) => {
    const source = await asAdmin(db, request, (scope) => rates.rateSource(scope))
    if (source === 'bcv') await bcv.refresh()
    return card(request)
  })

  app.post('/exchange-rates', async (request, reply) => {
    const input = parseInput(manualRateInput, request.body)
    await asAdmin(db, request, (scope) => rates.addManual(scope, input))
    return reply.code(201).send(await card(request))
  })

  done()
}

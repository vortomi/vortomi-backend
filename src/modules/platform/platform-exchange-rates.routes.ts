import type { FastifyPluginCallback } from 'fastify'
import { identityOf } from '../../http/authenticate.ts'
import { parseInput } from '../../http/validation.ts'
import type { BcvRateService } from '../exchange-rates/bcv-rate.service.ts'
import { manualRateInput, rateSourceInput } from '../exchange-rates/exchange-rate-service.ts'
import type { PlatformExchangeRateService } from './platform-exchange-rates.ts'

export interface PlatformExchangeRateRoutesOptions {
  rates: PlatformExchangeRateService
  bcv: Pick<BcvRateService, 'refresh'>
}

/**
 * /platform/exchange-rates (mockup web-36): the same routes as a company's, for Vortomi's own rate.
 * Registered inside platformRoutes, so its guard (super admin with the second factor) runs first.
 * Every answer is the whole card.
 */
export const platformExchangeRateRoutes: FastifyPluginCallback<PlatformExchangeRateRoutesOptions> = (app, { rates, bcv }, done) => {
  app.get('/exchange-rates', () => rates.view())

  // Switching to the BCV reads it before answering, so the card shows its rate right away.
  app.put('/exchange-rates/source', async (request) => {
    const { rateSource } = parseInput(rateSourceInput, request.body)
    await rates.setSource(rateSource)
    if (rateSource === 'bcv') await bcv.refresh()
    return rates.view()
  })

  // "Actualizar ahora": with a typed rate there is nothing to read.
  app.post('/exchange-rates/bcv', async () => {
    if ((await rates.rateSource()) === 'bcv') await bcv.refresh()
    return rates.view()
  })

  app.post('/exchange-rates', async (request, reply) => {
    const input = parseInput(manualRateInput, request.body)
    await rates.addManual(input, identityOf(request).userId)
    return reply.code(201).send(await rates.view())
  })

  done()
}

// Vortomi's own exchange rate (console → Ajustes → Tasa de cambio, mockup web-36): only super
// admins with the second factor reach it; the same rules as a company's rate; the platform's single
// BCV read feeds it; it never touches any company's rate; no company can read it.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exchangeRates, platformExchangeRates, platformSettings } from '../../src/db/schema/index.ts'
import { BcvRateService } from '../../src/modules/exchange-rates/bcv-rate.service.ts'
import type { ExchangeRateView } from '../../src/modules/exchange-rates/exchange-rate-service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { FakeBcvSource, buildTestApp, silentLog } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let company: SeededTenant
const who = { yornel: '', laura: '' }
const bcvPage = new FakeBcvSource()
let clock = 0

const caracasDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date(Date.now() + offsetDays * 86_400_000))

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a: company } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, company.tenantId, who.laura, { role: 'admin' })
  // Every read is a minute after the last: the BCV is never skipped for being read a moment ago.
  const bcv = new BcvRateService(t.db, bcvPage, silentLog, () => (clock += 61_000))
  app = await buildTestApp(t.db, { bcv })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PUT'
const console_ = async (method: Method, path: string, payload?: object, userId = who.yornel, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal }), ...(payload ? { payload } : {}) })
const view = async () => (await console_('GET', '/exchange-rates')).json<ExchangeRateView>()

describe('who reaches it', () => {
  it('only a super admin, and only with the second factor', async () => {
    expect((await console_('GET', '/exchange-rates', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('POST', '/exchange-rates', { bsPerUsd: '415', effectiveDate: caracasDay() }, who.yornel, 'aal1')).json()).toEqual({
      error: 'second_factor_required',
    })
  })
})

describe('Vortomi’s rate', () => {
  it('starts as a new company does: typed by hand, with no rate yet', async () => {
    expect(await view()).toEqual({ rateSource: 'custom', bcv: { bsPerUsd: null, effectiveDate: null, checkedAt: null, error: null }, exchangeRates: [], system: null })
  })

  it('takes a rate typed by hand, with its author and the rate before it', async () => {
    expect((await console_('POST', '/exchange-rates', { bsPerUsd: '415,00', effectiveDate: caracasDay() })).statusCode).toBe(400)
    const first = await console_('POST', '/exchange-rates', { bsPerUsd: '410.5', effectiveDate: caracasDay() })
    expect(first.statusCode).toBe(201)
    const second = (await console_('POST', '/exchange-rates', { bsPerUsd: '415', effectiveDate: caracasDay() })).json<ExchangeRateView>()
    expect(second.exchangeRates[0]).toMatchObject({ bsPerUsd: '415.00000000', previousBsPerUsd: '410.50000000', source: 'manual', changedBy: 'Yornel' })
    expect(second.exchangeRates).toHaveLength(2)
  })

  it('switches to the BCV and reads it before answering; «Actualizar ahora» does nothing while typed by hand', async () => {
    const before = bcvPage.reads
    await console_('POST', '/exchange-rates/bcv')
    expect(bcvPage.reads).toBe(before)
    bcvPage.next = { bsPerUsd: '412.87300000', effectiveDate: caracasDay() }
    const switched = (await console_('PUT', '/exchange-rates/source', { rateSource: 'bcv' })).json<ExchangeRateView>()
    expect(switched.rateSource).toBe('bcv')
    expect(switched.bcv).toMatchObject({ bsPerUsd: '412.87300000', effectiveDate: caracasDay(), error: null })
    expect(switched.exchangeRates[0]).toMatchObject({ bsPerUsd: '412.87300000', previousBsPerUsd: '415.00000000', source: 'bcv', changedBy: null })
  })

  it('takes the BCV’s next rate only from its day on, Caracas time', async () => {
    bcvPage.next = { bsPerUsd: '420.00000000', effectiveDate: caracasDay(1) }
    const after = (await console_('POST', '/exchange-rates/bcv')).json<ExchangeRateView>()
    expect(after.bcv).toMatchObject({ bsPerUsd: '420.00000000', effectiveDate: caracasDay(1) })
    expect(after.exchangeRates[0]).toMatchObject({ bsPerUsd: '412.87300000' })
  })

  it('never touches a company’s rate, and the history only grows', async () => {
    expect(await t.db.select().from(exchangeRates)).toEqual([])
    expect(await dbError(t.db.update(platformExchangeRates).set({ rate: '1' }))).toContain('append-only')
    expect(await dbError(t.db.delete(platformExchangeRates))).toContain('append-only')
  })

  it('stays apart from every company: not readable from their scope', async () => {
    await expect(withTenant(t.db, company.tenantId, ({ tx }) => tx.select().from(platformExchangeRates))).rejects.toThrow()
    await expect(withTenant(t.db, company.tenantId, ({ tx }) => tx.select().from(platformSettings))).rejects.toThrow()
  })
})

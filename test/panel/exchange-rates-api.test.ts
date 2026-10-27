// The exchange rate of each company: typed by an admin, or read from the BCV and applied from its
// fecha valor. Every rate stays in the company's history; nothing is edited; companies never mix.
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exchangeRates } from '../../src/db/schema/index.ts'
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
let a: SeededTenant
let b: SeededTenant
const bcvPage = new FakeBcvSource()
const who = { laura: '', carlos: '', boris: '' }
// Each refresh happens "a minute later", so the read-at-most-once-a-minute guard never blocks a test.
let clock = 0

const caracasDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date(Date.now() + offsetDays * 86_400_000))

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.boris = await seedUser(t.db, 'Boris')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.boris, { role: 'admin' })
  const bcv = new BcvRateService(t.db, bcvPage, silentLog, () => (clock += 61_000))
  app = await buildTestApp(t.db, { bcv })
})

afterAll(async () => {
  await app.close()
  await t.close()
})

async function call(userId: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, tenantId = a.tenantId) {
  return app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
}
const view = async (userId = who.laura, tenantId = a.tenantId) => (await call(userId, 'GET', '/exchange-rates', undefined, tenantId)).json<ExchangeRateView>()

describe('a rate typed by hand', () => {
  it('starts with no rate and the typed source', async () => {
    expect(await view()).toEqual({ rateSource: 'custom', bcv: { bsPerUsd: null, effectiveDate: null, checkedAt: null, error: null }, exchangeRates: [] })
  })

  it('an admin registers it; it is the rate at once and keeps the previous one; agents only read', async () => {
    expect((await call(who.carlos, 'POST', '/exchange-rates', { bsPerUsd: '36.52', effectiveDate: caracasDay() })).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/exchange-rates', { bsPerUsd: '36,52', effectiveDate: caracasDay() })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '/exchange-rates', { bsPerUsd: '36.52', effectiveDate: caracasDay() })).statusCode).toBe(201)
    const saved = (await call(who.laura, 'POST', '/exchange-rates', { bsPerUsd: '37', effectiveDate: caracasDay(3) })).json<ExchangeRateView>()
    expect(saved.exchangeRates.map(({ createdAt: _at, ...rate }) => rate)).toEqual([
      { bsPerUsd: '37.00000000', previousBsPerUsd: '36.52000000', effectiveDate: caracasDay(3), changedBy: 'Laura', source: 'manual' },
      { bsPerUsd: '36.52000000', previousBsPerUsd: null, effectiveDate: caracasDay(), changedBy: 'Laura', source: 'manual' },
    ])
    expect((await view(who.carlos)).exchangeRates[0]?.bsPerUsd).toBe('37.00000000')
  })

  it('"Actualizar ahora" reads nothing while the company types its rate', async () => {
    await call(who.laura, 'POST', '/exchange-rates/bcv')
    expect(bcvPage.reads).toBe(0)
  })
})

describe('the BCV rate', () => {
  it('switching to it reads the BCV and applies today\'s rate, in this company only', async () => {
    bcvPage.next = { bsPerUsd: '887.30200000', effectiveDate: caracasDay() }
    expect((await call(who.carlos, 'PUT', '/exchange-rates/source', { rateSource: 'bcv' })).json()).toEqual({ error: 'admin_required' })
    const switched = (await call(who.laura, 'PUT', '/exchange-rates/source', { rateSource: 'bcv' })).json<ExchangeRateView>()
    expect(switched.rateSource).toBe('bcv')
    expect(switched.bcv).toMatchObject({ bsPerUsd: '887.30200000', effectiveDate: caracasDay(), error: null })
    expect(switched.exchangeRates[0]).toMatchObject({ bsPerUsd: '887.30200000', previousBsPerUsd: '37.00000000', source: 'bcv', changedBy: null })
    expect((await view(who.boris, b.tenantId)).exchangeRates).toEqual([])
  })

  it('the same value again adds nothing', async () => {
    await call(who.laura, 'POST', '/exchange-rates/bcv')
    expect((await view()).exchangeRates).toHaveLength(3)
  })

  it('a rate published for tomorrow is shown but not applied before its day', async () => {
    bcvPage.next = { bsPerUsd: '890.10000000', effectiveDate: caracasDay(1) }
    const after = (await call(who.laura, 'POST', '/exchange-rates/bcv')).json<ExchangeRateView>()
    expect(after.bcv).toMatchObject({ bsPerUsd: '890.10000000', effectiveDate: caracasDay(1) })
    expect(after.exchangeRates[0]?.bsPerUsd).toBe('887.30200000')
  })

  it('a failed read keeps the last rate and says why', async () => {
    bcvPage.next = 'la página del BCV cambió y no encontramos la tasa.'
    const after = (await call(who.laura, 'POST', '/exchange-rates/bcv')).json<ExchangeRateView>()
    expect(after.bcv).toMatchObject({ bsPerUsd: '890.10000000', error: 'la página del BCV cambió y no encontramos la tasa.' })
    expect(after.exchangeRates[0]?.bsPerUsd).toBe('887.30200000')
  })

  it('back to typed: the BCV is not read any more; the rate stays until one is typed', async () => {
    const before = bcvPage.reads
    const back = (await call(who.laura, 'PUT', '/exchange-rates/source', { rateSource: 'custom' })).json<ExchangeRateView>()
    await call(who.laura, 'POST', '/exchange-rates/bcv')
    expect(bcvPage.reads).toBe(before)
    expect(back).toMatchObject({ rateSource: 'custom', exchangeRates: [{ bsPerUsd: '887.30200000', source: 'bcv' }, {}, {}] })
  })
})

describe('the history', () => {
  it('is never changed or deleted, not even by the server', async () => {
    expect(await dbError(t.db.update(exchangeRates).set({ rate: '1' }))).toContain('append-only')
    expect(await dbError(t.db.delete(exchangeRates))).toContain('append-only')
  })

  it('company code can only add typed rates as the person acting', async () => {
    const insert = (values: Partial<typeof exchangeRates.$inferInsert>) =>
      withTenant(t.db, a.tenantId, async ({ tx }) => {
        await tx.execute(sql`select set_config('app.user_id', ${who.laura}, true)`)
        await tx.insert(exchangeRates).values({ tenantId: a.tenantId, rate: '1', effectiveDate: caracasDay(), source: 'manual', changedBy: who.laura, ...values })
      })
    expect(await dbError(insert({ source: 'bcv', changedBy: null }))).toContain('row-level security')
    expect(await dbError(insert({ changedBy: who.carlos }))).toContain('row-level security')
    expect(await dbError(insert({ tenantId: b.tenantId }))).toContain('row-level security')
  })
})

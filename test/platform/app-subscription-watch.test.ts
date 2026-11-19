// Which apps receive each number's messages (mockup web-31): the server reads it from Meta, keeps
// it apart from the companies' data and the console raises a critical alert for a foreign app.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { channelAppChecks } from '../../src/db/schema/index.ts'
import { AppSubscriptionWatch, watchingSubscriptions } from '../../src/modules/platform/app-subscription-watch.ts'
import { PlatformAlertService } from '../../src/modules/platform/platform-alert-service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { UsageService } from '../../src/modules/usage/usage-service.ts'
import { type MetaApp, type SubscriptionReader, type WabaDirectory, WhatsAppApiError } from '../../src/modules/whatsapp/cloud-api.client.ts'
import { testCredentials } from '../helpers/app.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const VORTOMI: MetaApp = { id: '1167128472338629', name: 'Vortomi' }
const TEST_APP: MetaApp = { id: '1794972675024829', name: 'mensajeria-crm' }
const FOREIGN: MetaApp = { id: '882956320901316', name: 'Vortex Autonomy' }
const SIGNUP_ONLY: MetaApp = { id: '555000111222333', name: 'Vortomi signup' }

/** Meta as a map: each token's app, and each account's subscribed apps. */
class FakeMeta implements SubscriptionReader {
  apps = new Map<string, MetaApp[]>()
  tokens = new Map<string, MetaApp>()
  down = new Set<string>()
  tokenCalls = 0

  tokenApp(token: string): Promise<MetaApp> {
    this.tokenCalls++
    const app = this.tokens.get(token)
    return app ? Promise.resolve(app) : Promise.reject(new WhatsAppApiError('Meta rejected the request (400)', 400, 190))
  }

  subscribedApps(wabaId: string): Promise<MetaApp[]> {
    if (this.down.has(wabaId)) return Promise.reject(new WhatsAppApiError('Cloud API request failed (TimeoutError)', null, null))
    return Promise.resolve(this.apps.get(wabaId) ?? [])
  }
}

let test: TestDatabase
let a: SeededTenant
let b: SeededTenant
let meta: FakeMeta
const log = { warn: vi.fn(), error: vi.fn() }
let clock = new Date('2026-11-19T13:00:00Z')

const watch = () => new AppSubscriptionWatch(test.db, credentials, meta, { ourAppIds: [SIGNUP_ONLY.id], log, now: () => clock, wakeDelayMs: 0 })
let credentials: ReturnType<typeof testCredentials>
const rowOf = async (channelAccountId: string) => (await test.db.select().from(channelAppChecks).where(eq(channelAppChecks.channelAccountId, channelAccountId)))[0]

beforeAll(async () => {
  test = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(test.db))
  credentials = testCredentials(test.db)
  await credentials.store(a.tenantId, a.channelAccountId, 'token-of-a')
  await credentials.store(b.tenantId, b.channelAccountId, 'token-of-b')
  meta = new FakeMeta()
  meta.tokens.set('token-of-a', VORTOMI)
  meta.tokens.set('token-of-b', TEST_APP)
})

afterAll(async () => {
  await test.close()
})

describe('the app watch', () => {
  it('ours are the apps of the stored tokens and the signup app; anything else is foreign', async () => {
    meta.apps.set(a.wabaId, [VORTOMI, FOREIGN])
    // An account may carry our other app too: still ours.
    meta.apps.set(b.wabaId, [TEST_APP, VORTOMI, SIGNUP_ONLY])

    expect(await watch().checkAll()).toEqual({ checked: 2, failed: 0, withForeignApps: 1 })

    const first = await rowOf(a.channelAccountId)
    expect(first).toMatchObject({ tenantId: a.tenantId, checkedAt: clock, failedAt: null })
    expect(first?.apps).toEqual([
      { id: VORTOMI.id, name: 'Vortomi', ours: true, firstSeenAt: clock.toISOString() },
      { id: FOREIGN.id, name: 'Vortex Autonomy', ours: false, firstSeenAt: clock.toISOString() },
    ])
    expect((await rowOf(b.channelAccountId))?.apps?.every((app) => app.ours)).toBe(true)
  })

  it('keeps when an app was first seen; a removed app goes away', async () => {
    const firstSeen = clock.toISOString()
    clock = new Date('2026-11-19T13:15:00Z')
    expect(await watch().checkAll()).toMatchObject({ withForeignApps: 1 })
    expect((await rowOf(a.channelAccountId))?.apps?.find((app) => app.id === FOREIGN.id)?.firstSeenAt).toBe(firstSeen)

    meta.apps.set(a.wabaId, [VORTOMI])
    clock = new Date('2026-11-19T13:30:00Z')
    expect(await watch().checkAll()).toMatchObject({ withForeignApps: 0 })
    expect((await rowOf(a.channelAccountId))?.apps).toEqual([{ id: VORTOMI.id, name: 'Vortomi', ours: true, firstSeenAt: firstSeen }])
  })

  it('when Meta does not answer, the last reading stays and the failure is noted', async () => {
    meta.down.add(a.wabaId)
    clock = new Date('2026-11-19T13:45:00Z')
    expect(await watch().checkAll()).toMatchObject({ checked: 1, failed: 1 })
    expect(await rowOf(a.channelAccountId)).toMatchObject({ checkedAt: new Date('2026-11-19T13:30:00Z'), failedAt: clock })
    expect(log.warn).toHaveBeenCalledWith({ channelId: a.channelAccountId, reason: 'Cloud API request failed (TimeoutError)' }, 'App subscriptions could not be read')
    // No token ever reaches the logs.
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('token-of')

    meta.down.clear()
    clock = new Date('2026-11-19T14:00:00Z')
    await watch().checkAll()
    expect(await rowOf(a.channelAccountId)).toMatchObject({ checkedAt: clock, failedAt: null })
  })

  it('asks Meta for a token\'s app once', async () => {
    const one = watch()
    await one.checkAll()
    const calls = meta.tokenCalls
    await one.checkAll()
    expect(meta.tokenCalls).toBe(calls)
  })

  it('connecting a number has every number read again', async () => {
    const wake = vi.fn()
    const subscribeApp = vi.fn(() => Promise.resolve())
    const directory = watchingSubscriptions({ subscribeApp } as unknown as WabaDirectory, { wake })
    await directory.subscribeApp(a.wabaId, 'token-of-a')
    expect(subscribeApp).toHaveBeenCalledWith(a.wabaId, 'token-of-a')
    expect(wake).toHaveBeenCalledTimes(1)

    // A refused subscription changes nothing.
    const refused = watchingSubscriptions({ subscribeApp: () => Promise.reject(new Error('no')) } as unknown as WabaDirectory, { wake })
    await expect(refused.subscribeApp(a.wabaId, 'x')).rejects.toThrow('no')
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('wake() reads shortly after, once for several calls', async () => {
    const one = watch()
    const spy = vi.spyOn(one, 'checkAll')
    one.wake()
    one.wake()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await one.idle()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('the console gets a critical alert with the foreign app, and the companies cannot read the table', async () => {
    meta.apps.set(a.wabaId, [VORTOMI, FOREIGN])
    clock = new Date('2026-11-19T14:15:00Z')
    await watch().checkAll()
    const report = await new PlatformAlertService(test.db, new UsageService(), { agentCap: 1000, webhookMaxAttempts: 5, now: () => clock }).report()
    expect(report.alerts.filter((alert) => alert.kind === 'foreign_app')).toMatchObject([
      { severity: 'critical', tenantId: a.tenantId, channelId: a.channelAccountId, facts: { apps: 'Vortex Autonomy (882956320901316)', count: 1, wabaId: a.wabaId } },
    ])
    expect(report.checked.appsUnread).toBe(0)

    await expect(withTenant(test.db, a.tenantId, ({ tx }) => tx.select().from(channelAppChecks))).rejects.toThrow()
  })
})

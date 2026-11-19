// The console's alerts (mockup web-25): each rule fires on real data Vortomi stores, says since when
// and carries facts (the console writes the sentences). Only our team reads them, with the second factor.
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentSettings, agentUsage, bcvStatus, channelAccounts, conversations, tenantSettings, tenants, webhookEvents } from '../../src/db/schema/index.ts'
import { IngestService } from '../../src/modules/conversations/ingest.service.ts'
import { OwnerAppIngest } from '../../src/modules/conversations/owner-app-ingest.ts'
import { type AlertFacts, platformAlerts } from '../../src/modules/platform/platform-alert-rules.ts'
import { PlatformAlertService } from '../../src/modules/platform/platform-alert-service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import type { InboundMessageEvent } from '../../src/modules/whatsapp/events.ts'
import { UsageService } from '../../src/modules/usage/usage-service.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const DAY = 86_400_000
const NOW = new Date('2026-11-18T15:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

describe('the rules', () => {
  const empty: AlertFacts = {
    now: NOW,
    tenants: [{ id: 't1', name: 'Panadería Corteza', status: 'active', createdAt: ago(60) }],
    channels: [{ id: 'c1', tenantId: 't1', label: 'Ventas', status: 'connected', statusReason: null, statusChangedAt: null, tokenExpiresAt: null, wabaId: '1523410889418669', foreignApps: [] }],
    webhooksFailed: null,
    unroutable: [],
    bcv: null,
    agentUsage: [],
    agentCap: 1000,
    catalogHandoffs: [],
    serviceReplies: [],
    inbound: [{ channelId: 'c1', lastAt: ago(1), before: 300 }],
  }

  it('a working company says nothing', () => {
    expect(platformAlerts(empty)).toEqual([])
  })

  it('the agent: 80 % is a warning, the whole cap is critical', () => {
    expect(platformAlerts({ ...empty, agentUsage: [{ tenantId: 't1', replies: 820 }] })).toMatchObject([{ kind: 'agent_cap_near', severity: 'warning', facts: { replies: 820, cap: 1000 } }])
    expect(platformAlerts({ ...empty, agentUsage: [{ tenantId: 't1', replies: 1000 }] })).toMatchObject([{ kind: 'agent_cap_reached', severity: 'critical' }])
  })

  it('a number that used to hear from customers and has not in 7 days; a new quiet one is not an alert', () => {
    expect(platformAlerts({ ...empty, inbound: [{ channelId: 'c1', lastAt: ago(8), before: 1200 }] })).toMatchObject([
      { kind: 'number_silent', channelLabel: 'Ventas', since: ago(8).toISOString(), facts: { perDay: 40 } },
    ])
    expect(platformAlerts({ ...empty, inbound: [{ channelId: 'c1', lastAt: ago(8), before: 0 }] })).toEqual([])
  })

  it('more than 1,000 service replies in a month: Meta starts charging', () => {
    expect(platformAlerts({ ...empty, serviceReplies: [{ tenantId: 't1', channelId: 'c1', count: 1140 }] })).toMatchObject([{ kind: 'free_replies_exceeded', facts: { replies: 1140, free: 1000 } }])
    expect(platformAlerts({ ...empty, serviceReplies: [{ tenantId: 't1', channelId: 'c1', count: 1000 }] })).toEqual([])
  })

  it('another app receiving the messages of a number is critical, since it was first seen (mockup web-31)', () => {
    const foreignApps = [{ id: '882956320901316', name: 'Vortex Autonomy', firstSeenAt: ago(0.5).toISOString() }]
    const channels = empty.channels.map((c) => ({ ...c, foreignApps }))
    expect(platformAlerts({ ...empty, channels })).toMatchObject([
      { kind: 'foreign_app', severity: 'critical', category: 'connection', channelLabel: 'Ventas', since: ago(0.5).toISOString(), facts: { apps: 'Vortex Autonomy (882956320901316)', count: 1, wabaId: '1523410889418669' } },
    ])
    // Even on a disconnected number: the account still delivers to that app.
    const down = channels.map((c) => ({ ...c, status: 'disconnected', statusReason: 'owner_disconnected' }))
    expect(platformAlerts({ ...empty, channels: down }).map((a) => a.kind)).toEqual(['foreign_app', 'channel_disconnected'])
  })

  it('the BCV only matters when some company prices with it', () => {
    const bcv = { error: 'La página del BCV no respondió.', checkedAt: ago(0.1), rate: '893.21', effectiveDate: '2026-11-17', companies: 0 }
    expect(platformAlerts({ ...empty, bcv })).toEqual([])
    expect(platformAlerts({ ...empty, bcv: { ...bcv, companies: 2 } })).toMatchObject([{ kind: 'bcv_unread', tenantId: null, facts: { companies: 2 } }])
  })

  it('critical first, the platform before the companies; a cancelled company is never an alert', () => {
    const alerts = platformAlerts({
      ...empty,
      tenants: [...empty.tenants, { id: 't2', name: 'De baja', status: 'cancelled', createdAt: ago(60) }],
      channels: [{ ...empty.channels[0]!, status: 'disconnected', statusReason: 'owner_disconnected', statusChangedAt: ago(0.1) }, { ...empty.channels[0]!, id: 'c2', tenantId: 't2', status: 'disconnected' }],
      webhooksFailed: { count: 2, firstAt: ago(0.2), lastError: 'inbound_message wamid.x: timeout' },
      unroutable: [{ key: '100000000000099', count: 3, lastAt: ago(0.5) }],
    })
    expect(alerts.map((a) => a.kind)).toEqual(['webhooks_failed', 'channel_disconnected', 'unroutable_number'])
  })
})

describe('the service and the console route', () => {
  let t: TestDatabase
  let app: FastifyInstance
  let a: SeededTenant
  let b: SeededTenant
  let yornel = ''
  let laura = ''

  const inbound = (tenant: SeededTenant, waMessageId: string, at: Date): Promise<unknown> => {
    const event: InboundMessageEvent = { kind: 'inbound_message', phoneNumberId: tenant.phoneNumberId, waMessageId, timestamp: at, from: '584125550101', profileName: 'Ana', type: 'text', body: 'Hola', replyId: null, waMediaId: null }
    return withTenant(t.db, tenant.tenantId, (scope) => new IngestService().recordInbound(scope, tenant.channelAccountId, event))
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    ;({ a, b } = await seedTwoTenants(t.db))
    yornel = await seedUser(t.db, 'Yornel', 'super_admin')
    laura = await seedUser(t.db, 'Laura')
    // A: its number stopped hearing from customers 10 days ago; its access ends in 3 days.
    // Stored with its own time, as the owner's app history is (a stored message is never rewritten).
    await withTenant(t.db, a.tenantId, (scope) =>
      new OwnerAppIngest().recordHistory(scope, a.channelAccountId, { kind: 'history_chunk', phoneNumberId: a.phoneNumberId, phase: 0, chunkOrder: 0, progress: 100, threads: [{ waId: '584125550101', messages: [{ waMessageId: 'w-old', timestamp: ago(10), fromBusiness: false, type: 'text', body: 'Hola', replyId: null, waMediaId: null }] }] }),
    )
    await t.db.update(channelAccounts).set({ tokenExpiresAt: new Date(NOW.getTime() + 3 * DAY) }).where(eq(channelAccounts.id, a.channelAccountId))
    // B: its owner disconnected the number; its agent used its whole month; its catalog failed today.
    await t.db.update(channelAccounts).set({ status: 'disconnected', statusReason: 'owner_disconnected', statusChangedAt: ago(0.1) }).where(eq(channelAccounts.id, b.channelAccountId))
    await t.db.insert(agentSettings).values({ tenantId: b.tenantId, enabled: true }).onConflictDoUpdate({ target: agentSettings.tenantId, set: { enabled: true } })
    await t.db.insert(agentUsage).values({ tenantId: b.tenantId, month: '2026-11-01', replies: 1000 })
    await inbound(b, 'w-b', ago(0.2))
    await t.db.update(conversations).set({ handoffAt: ago(0.1), handoffReason: 'catalog_unavailable' }).where(eq(conversations.tenantId, b.tenantId))
    // The platform: a webhook given up, one for a number nobody owns, the BCV unread while A uses it.
    await t.db.insert(webhookEvents).values({ payload: {}, receivedAt: ago(0.3), attempts: 7, lastError: 'inbound_message wamid.y: connection terminated' })
    await t.db.insert(webhookEvents).values({ payload: {}, receivedAt: ago(0.5), processedAt: ago(0.5), attempts: 1, lastError: 'unroutable: 100000000000099' })
    await t.db.insert(bcvStatus).values({ id: true, rate: '893.21', effectiveDate: '2026-11-17', checkedAt: ago(0.1), error: 'La página del BCV no respondió.' }).onConflictDoUpdate({ target: bcvStatus.id, set: { error: 'La página del BCV no respondió.' } })
    await t.db.insert(tenantSettings).values({ tenantId: a.tenantId, rateSource: 'bcv' }).onConflictDoUpdate({ target: tenantSettings.tenantId, set: { rateSource: 'bcv' } })
    app = await buildTestApp(t.db)
  })

  afterAll(async () => {
    await app.close()
    await t.close()
  })

  it('finds every problem in the data, each with its company and since when', async () => {
    const report = await new PlatformAlertService(t.db, new UsageService(), { agentCap: 1000, webhookMaxAttempts: 7, now: () => NOW }).report()
    const [nameA] = await t.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, a.tenantId))
    // Nothing read their apps yet: the console does not vouch for them (mockup web-31).
    expect(report.checked).toEqual({ companies: 2, numbers: 2, connected: 1, appsUnread: 2 })
    const kinds = report.alerts.map((alert) => `${alert.kind}${alert.tenantId === a.tenantId ? ':A' : alert.tenantId === b.tenantId ? ':B' : ''}`)
    expect(kinds.sort()).toEqual(['access_expiring:A', 'agent_cap_reached:B', 'bcv_unread', 'catalog_unavailable:B', 'channel_disconnected:B', 'number_silent:A', 'unroutable_number', 'webhooks_failed'].sort())
    expect(report.alerts.find((x) => x.kind === 'access_expiring')).toMatchObject({ tenantName: nameA!.name, channelId: a.channelAccountId, facts: { days: 3 } })
    expect(report.alerts.find((x) => x.kind === 'webhooks_failed')?.facts).toEqual({ count: 1, lastError: 'inbound_message wamid.y: connection terminated' })
    expect(report.alerts.find((x) => x.kind === 'catalog_unavailable')?.facts).toEqual({ conversations: 1 })
  })

  it('only our team reads them, and only with the second factor', async () => {
    const as = async (userId: string, aal: 'aal1' | 'aal2') => app.inject({ method: 'GET', url: '/api/platform/alerts', headers: await bearer(userId, { aal }) })
    const ok = await as(yornel, 'aal2')
    expect(ok.statusCode).toBe(200)
    const body = ok.json<{ checked: { companies: number }; alerts: unknown[] }>()
    expect(body.checked.companies).toBe(2)
    expect(body.alerts.length).toBeGreaterThan(0)
    expect((await as(yornel, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
    expect((await as(laura, 'aal2')).json()).toEqual({ error: 'platform_admin_required' })
  })
})

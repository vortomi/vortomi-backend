// A company's subscription to Vortomi (documentations/18, stage 2; mockup web-37): the console
// assigns a plan (active plans only, once, never to a draft), which makes the first charge due that
// day; Cobros lists every company; the company reads its own subscription. While the rule is
// enforced, a company past its suspension date is locked out of everything but Suscripción and its
// bot is silent.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { companySubscriptions, platformActivity, platformExchangeRates, subscriptionCharges, tenants } from '../../src/db/schema/index.ts'
import { setBillingEnforcement } from '../../src/modules/subscriptions/billing-enforcement.ts'
import { addDays, caracasToday } from '../../src/modules/subscriptions/subscription-rules.ts'
import { companyIsActive } from '../../src/modules/tenancy/company-status.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { yornel: '', laura: '', carlos: '' }
const plan = { equipo: '', paused: '' }
const today = caracasToday()

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.carlos, { role: 'agent' })
  app = await buildTestApp(t.db)
  const base = { description: 'Para equipos.', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, benefits: ['Todo incluido'] }
  plan.equipo = (await console_('POST', '/plans', { ...base, name: 'Equipo', isActive: true })).json<{ id: string }>().id
  plan.paused = (await console_('POST', '/plans', { ...base, name: 'Pausado', isActive: false })).json<{ id: string }>().id
})

afterEach(() => setBillingEnforcement(false))

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'DELETE'
async function console_(method: Method, path: string, payload?: object, userId = who.yornel) {
  return app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
}
const panel = async (path: string, userId = who.laura, tenantId = a.tenantId) =>
  app.inject({ method: 'GET', url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId) })

interface View {
  state: string
  enforced: boolean
  plan: { id: string; name: string; priceCents: number }
  billingDay: number | null
  nextDueOn: string
  suspendsOn: string
  owedCents: number
  charge: { months: number; amountCents: number; paidCents: number; dueOn: string } | null
  rate: { bsPerUsd: string } | null
}
interface Row {
  tenantId: string
  planName: string | null
  owedCents: number
  state: string
}

describe('a company without a plan', () => {
  it('has no subscription and appears in Cobros as without plan', async () => {
    expect((await console_('GET', `/tenants/${a.tenantId}/subscription`)).json()).toEqual({ subscription: null })
    expect((await panel('/subscription')).json()).toEqual({ subscription: null })
    const rows = (await console_('GET', '/subscriptions')).json<{ items: Row[] }>().items
    expect(rows.find((r) => r.tenantId === a.tenantId)).toMatchObject({ planName: null, owedCents: 0, state: 'none' })
  })
})

describe('assigning a plan', () => {
  it('only an active plan, and never to a draft', async () => {
    expect((await console_('POST', `/tenants/${a.tenantId}/subscription`, { planId: plan.paused })).json()).toEqual({ error: 'plan_unavailable' })
    const [draft] = await t.db
      .insert(tenants)
      .values({ name: 'Borrador', slug: 'borrador', status: 'draft', plan: 'team', legalName: 'Borrador, C.A.', taxId: 'J-41234567-9', fiscalAddress: 'Caracas' })
      .returning({ id: tenants.id })
    expect((await console_('POST', `/tenants/${draft!.id}/subscription`, { planId: plan.equipo })).json()).toEqual({ error: 'tenant_not_found' })
  })

  it('makes the first charge, 1 month due today: 3 days to pay', async () => {
    await t.db.insert(platformExchangeRates).values({ rate: '120.50000000', effectiveDate: today, source: 'manual', changedBy: who.yornel })
    const assigned = await console_('POST', `/tenants/${a.tenantId}/subscription`, { planId: plan.equipo })
    expect(assigned.statusCode).toBe(201)
    const view = assigned.json<{ subscription: View }>().subscription
    expect(view).toMatchObject({
      state: 'awaiting_first_payment',
      enforced: false,
      plan: { id: plan.equipo, name: 'Equipo', priceCents: 7900 },
      billingDay: null,
      nextDueOn: today,
      suspendsOn: addDays(today, 3),
      owedCents: 7900,
      charge: { months: 1, amountCents: 7900, paidCents: 0, dueOn: today },
      rate: { bsPerUsd: '120.50000000' },
    })
  })

  it('only once: changing the plan is a later stage', async () => {
    expect((await console_('POST', `/tenants/${a.tenantId}/subscription`, { planId: plan.equipo })).json()).toEqual({ error: 'subscription_exists' })
  })

  it('is written in the console activity', async () => {
    const actions = await t.db.select({ action: platformActivity.action }).from(platformActivity).where(eq(platformActivity.tenantId, a.tenantId))
    expect(actions.map((i) => i.action)).toContain('subscription.plan_assigned')
  })

  it('a plan a company has is never deleted, and counts it', async () => {
    expect((await console_('DELETE', `/plans/${plan.equipo}`)).json()).toEqual({ error: 'plan_in_use' })
    const plans = (await console_('GET', '/plans')).json<{ items: { id: string; companies: number }[] }>().items
    expect(plans.find((p) => p.id === plan.equipo)?.companies).toBe(1)
  })

  it('shows in Cobros with what it owes', async () => {
    const rows = (await console_('GET', '/subscriptions')).json<{ items: Row[] }>().items
    expect(rows.find((r) => r.tenantId === a.tenantId)).toMatchObject({ planName: 'Equipo', owedCents: 7900, state: 'awaiting_first_payment' })
    expect(rows.find((r) => r.tenantId === b.tenantId)).toMatchObject({ state: 'none' })
  })
})

describe('what the company sees', () => {
  it('its admins read their subscription; agents and outsiders do not', async () => {
    expect((await panel('/subscription')).json<{ subscription: View }>().subscription).toMatchObject({ state: 'awaiting_first_payment', owedCents: 7900 })
    expect((await panel('/subscription', who.carlos)).json()).toEqual({ error: 'admin_required' })
    expect((await panel('/subscription', who.laura, b.tenantId)).json()).toEqual({ error: 'not_a_member' })
  })

  it('reads only its own rows, and writes none', async () => {
    await t.db.insert(companySubscriptions).values({ tenantId: b.tenantId, planId: plan.equipo, nextDueOn: today })
    const seen = await withTenant(t.db, a.tenantId, ({ tx }) => tx.select({ id: companySubscriptions.tenantId }).from(companySubscriptions))
    expect(seen).toEqual([{ id: a.tenantId }])
    await expect(
      withTenant(t.db, a.tenantId, ({ tx }) => tx.update(subscriptionCharges).set({ paidCents: 7900 }).where(eq(subscriptionCharges.tenantId, a.tenantId))),
    ).rejects.toThrow()
    await t.db.delete(companySubscriptions).where(eq(companySubscriptions.tenantId, b.tenantId))
  })
})

describe('past the suspension date', () => {
  const overdue = () => t.db.update(companySubscriptions).set({ nextDueOn: addDays(today, -3) }).where(eq(companySubscriptions.tenantId, a.tenantId))

  it('is suspended on paper, but nothing is locked while the rule is off', async () => {
    await overdue()
    expect((await panel('/subscription')).json<{ subscription: View }>().subscription).toMatchObject({ state: 'suspended', enforced: false })
    expect((await panel('/payment-methods')).statusCode).toBe(200)
    expect(await companyIsActive(t.db)(a.tenantId)).toBe(true)
  })

  it('with the rule on: only Suscripción stays open, and the bot is silent', async () => {
    setBillingEnforcement(true)
    expect((await panel('/payment-methods')).json()).toEqual({ error: 'company_unpaid' })
    expect((await panel('/subscription')).json<{ subscription: View }>().subscription).toMatchObject({ state: 'suspended', enforced: true })
    expect((await panel('/plans')).statusCode).toBe(200)
    expect(await companyIsActive(t.db)(a.tenantId)).toBe(false)
    // Another company, up to date, works as always.
    expect(await companyIsActive(t.db)(b.tenantId)).toBe(true)
  })

  it('paying the whole debt lifts it at once', async () => {
    setBillingEnforcement(true)
    await t.db.update(subscriptionCharges).set({ paidCents: 7900 }).where(eq(subscriptionCharges.tenantId, a.tenantId))
    expect((await panel('/payment-methods')).statusCode).toBe(200)
    expect(await companyIsActive(t.db)(a.tenantId)).toBe(true)
  })
})

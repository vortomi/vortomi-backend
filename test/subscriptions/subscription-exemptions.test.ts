// «Exonerar del pago» (documentations/18 §8; mockup web-49): an exempt company pays nothing and is
// never suspended; exempting forgives what it owes; removing an exemption ends it 7 days later; once
// over, the company pays from the day after its last exempt day. The company sees only until when.
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyExemptions, companySubscriptions, companyTrials, platformActivity, platformExchangeRates, subscriptionCharges } from '../../src/db/schema/index.ts'
import { setBillingEnforcement } from '../../src/modules/subscriptions/billing-enforcement.ts'
import { SubscriptionBillingJob } from '../../src/modules/subscriptions/subscription-billing-job.ts'
import { ExemptionService } from '../../src/modules/subscriptions/subscription-exemptions.ts'
import { addDays, caracasToday } from '../../src/modules/subscriptions/subscription-rules.ts'
import { SubscriptionService, unpaidAndSuspended } from '../../src/modules/subscriptions/subscription-service.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
let plan = ''
let zelle = ''
const who = { yornel: '', laura: '', rosa: '' }
const today = caracasToday()
const silent = { info: () => undefined, error: () => undefined }

const consoleCall = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(who.yornel, { aal: 'aal2' }), ...(payload ? { payload } : {}) })
const companyCall = async (method: 'GET' | 'POST', path: string, userId: string, tenantId: string, payload?: object) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })

const actionsOf = async (tenantId: string) =>
  (await t.db.select({ action: platformActivity.action }).from(platformActivity).where(eq(platformActivity.tenantId, tenantId))).map((x) => x.action)
const chargesOf = (tenantId: string) =>
  t.db.select({ amount: subscriptionCharges.amountCents, paid: subscriptionCharges.paidCents, dueOn: subscriptionCharges.dueOn, months: subscriptionCharges.months }).from(subscriptionCharges).where(eq(subscriptionCharges.tenantId, tenantId))
const subscriptionOf = async (tenantId: string) =>
  (await t.db.select({ nextDueOn: companySubscriptions.nextDueOn, billingDay: companySubscriptions.billingDay }).from(companySubscriptions).where(eq(companySubscriptions.tenantId, tenantId)))[0]

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  who.rosa = await seedUser(t.db, 'Rosa')
  await seedMembership(t.db, b.tenantId, who.rosa, { role: 'admin' })
  app = await buildTestApp(t.db)
  plan = (await consoleCall('POST', '/plans', { name: 'Vortomi', description: '', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, benefits: [], isActive: true })).json<{ id: string }>().id
  zelle = (await consoleCall('POST', '/payment-methods', { instructions: '', referenceRule: 'required', isActive: true, type: 'zelle', name: 'Zelle', receiptRule: 'optional', fields: [] })).json<{ id: string }>().id
  await t.db.insert(platformExchangeRates).values({ rate: '410.55000000', effectiveDate: today, source: 'manual', changedBy: who.yornel })
})

afterAll(async () => {
  setBillingEnforcement(false)
  await app.close()
  await t.close()
})

describe('exempt with no end: a company that owed its first charge', () => {
  it('forgives what it owed, and the company is exempt', async () => {
    await companyCall('POST', '/subscription', who.laura, a.tenantId, { planId: plan, months: 3 })
    const granted = await consoleCall('POST', `/tenants/${a.tenantId}/exemption`, { reason: 'demo', note: 'La usan los revisores de Meta.', endsOn: null })
    expect(granted.statusCode).toBe(201)
    expect(granted.json<{ exemption: object }>().exemption).toMatchObject({ reason: 'demo', endsOn: null, forgivenCents: 22515, grantedByName: 'Yornel' })
    expect(await chargesOf(a.tenantId)).toEqual([])
    expect(await actionsOf(a.tenantId)).toContain('subscription.exempted')
  })

  it('shows as exempt to the company (only until when) and in Cobros (with its reason)', async () => {
    const mine = (await companyCall('GET', '/subscription', who.laura, a.tenantId)).json<{ subscription: { state: string; owedCents: number }; exemption: object }>()
    expect(mine.subscription).toMatchObject({ state: 'exempt', owedCents: 0 })
    expect(mine.exemption).toEqual({ endsOn: null })
    expect(JSON.stringify(mine)).not.toContain('revisores')
    const rows = (await consoleCall('GET', '/subscriptions')).json<{ items: { tenantId: string; state: string; exemption: object | null }[] }>().items
    expect(rows.find((r) => r.tenantId === a.tenantId)).toMatchObject({ state: 'exempt', exemption: { reason: 'demo', endsOn: null } })
  })

  it('is never suspended or charged, and a second exemption is refused', async () => {
    setBillingEnforcement(true)
    expect(await unpaidAndSuspended(t.db, a.tenantId, addDays(today, 60))).toBe(false)
    setBillingEnforcement(false)
    expect(await new SubscriptionBillingJob(t.db, silent, () => addDays(today, 60)).run()).toBe(0)
    expect((await consoleCall('POST', `/tenants/${a.tenantId}/exemption`, { reason: 'internal', endsOn: null })).json()).toEqual({ error: 'exemption_exists' })
  })

  it('removing it ends it 7 days later, never the same day', async () => {
    const removed = await consoleCall('DELETE', `/tenants/${a.tenantId}/exemption`)
    expect(removed.json<{ exemption: { endsOn: string } }>().exemption.endsOn).toBe(addDays(today, 7))
    expect(await actionsOf(a.tenantId)).toContain('subscription.exemption_removed')
    const later = new SubscriptionService(t.db, () => addDays(today, 7))
    expect((await later.view(a.tenantId))?.state).toBe('exempt')
  })

  it('once over, its first month falls due the day after its last exempt day', async () => {
    const after = addDays(today, 8)
    expect(await new SubscriptionBillingJob(t.db, silent, () => after).run()).toBe(1)
    expect(await subscriptionOf(a.tenantId)).toEqual({ nextDueOn: after, billingDay: null })
    expect(await chargesOf(a.tenantId)).toEqual([{ amount: 7900, paid: 0, dueOn: after, months: 1 }])
    const view = await new SubscriptionService(t.db, () => after).view(a.tenantId)
    expect(view).toMatchObject({ state: 'awaiting_first_payment', owedCents: 7900, suspendsOn: addDays(after, 3) })
    // Run again: nothing new.
    expect(await new SubscriptionBillingJob(t.db, silent, () => after).run()).toBe(0)
  })

  it('a payment in review must be decided before exempting', async () => {
    await t.db.update(subscriptionCharges).set({ dueOn: today }).where(eq(subscriptionCharges.tenantId, a.tenantId))
    await t.db.update(companySubscriptions).set({ nextDueOn: today }).where(eq(companySubscriptions.tenantId, a.tenantId))
    await t.db.update(companyExemptions).set({ endsOn: addDays(today, -1) }).where(eq(companyExemptions.tenantId, a.tenantId))
    const sent = await companyCall('POST', '/subscription/payments', who.laura, a.tenantId, {
      methodId: zelle,
      months: 1,
      paidOn: today,
      amount: '79.00',
      reference: 'ZX30001',
      payer: { senderName: 'Laura Méndez', senderContact: 'laura@gmail.com' },
      proof: null,
    })
    expect(sent.statusCode).toBe(201)
    expect((await consoleCall('POST', `/tenants/${a.tenantId}/exemption`, { reason: 'founder', endsOn: null })).json()).toEqual({ error: 'exemption_payment_in_review' })
  })
})

describe('exempt until a day: a company with no plan', () => {
  const endsOn = addDays(today, 30)

  it('«other» needs a note; a past end is refused', async () => {
    expect((await consoleCall('POST', `/tenants/${b.tenantId}/exemption`, { reason: 'other', endsOn })).statusCode).toBe(400)
    expect((await consoleCall('POST', `/tenants/${b.tenantId}/exemption`, { reason: 'founder', endsOn: addDays(today, -1) })).json()).toEqual({ error: 'exemption_end_past' })
    const granted = await consoleCall('POST', `/tenants/${b.tenantId}/exemption`, { reason: 'founder', note: 'Primer cliente.', endsOn })
    expect(granted.json<{ exemption: object }>().exemption).toMatchObject({ reason: 'founder', endsOn, forgivenCents: 0 })
  })

  it('is not suspended after its trial while exempt', async () => {
    await t.db.insert(companyTrials).values({ tenantId: b.tenantId, endsOn: addDays(today, -1) })
    setBillingEnforcement(true)
    expect(await unpaidAndSuspended(t.db, b.tenantId, addDays(today, 20))).toBe(false)
    expect(await unpaidAndSuspended(t.db, b.tenantId, addDays(endsOn, 1))).toBe(true)
    setBillingEnforcement(false)
  })

  it('may choose its plan meanwhile: the first charge is due the day after the exemption', async () => {
    const chosen = await companyCall('POST', '/subscription', who.rosa, b.tenantId, { planId: plan, months: 3 })
    expect(chosen.statusCode).toBe(201)
    expect(chosen.json<{ subscription: { state: string; nextDueOn: string } }>().subscription).toMatchObject({ state: 'exempt', nextDueOn: addDays(endsOn, 1) })
    expect(await chargesOf(b.tenantId)).toEqual([{ amount: 22515, paid: 0, dueOn: addDays(endsOn, 1), months: 3 }])
  })

  it('changing the end moves that charge too, sooner or later', async () => {
    const sooner = addDays(today, 10)
    const changed = await consoleCall('PUT', `/tenants/${b.tenantId}/exemption`, { reason: 'founder', note: 'Primer cliente.', endsOn: sooner })
    expect(changed.json<{ exemption: { endsOn: string } }>().exemption.endsOn).toBe(sooner)
    expect((await chargesOf(b.tenantId))[0]?.dueOn).toBe(addDays(sooner, 1))
    expect((await subscriptionOf(b.tenantId))?.nextDueOn).toBe(addDays(sooner, 1))
    expect(await actionsOf(b.tenantId)).toContain('subscription.exemption_changed')
  })

  it('a company exempt with no end has no plan to choose', async () => {
    await t.db.delete(subscriptionCharges).where(eq(subscriptionCharges.tenantId, b.tenantId))
    await t.db.delete(companySubscriptions).where(eq(companySubscriptions.tenantId, b.tenantId))
    await consoleCall('PUT', `/tenants/${b.tenantId}/exemption`, { reason: 'founder', note: 'Primer cliente.', endsOn: null })
    expect((await companyCall('POST', '/subscription', who.rosa, b.tenantId, { planId: plan, months: 1 })).json()).toEqual({ error: 'company_exempt' })
  })
})

describe('the exemption is Vortomi’s to write; the company reads only until when', () => {
  it('a company reads its own last exempt day, never the reason, and writes nothing', async () => {
    const own = await withTenant(t.db, b.tenantId, ({ tx }) => tx.select({ endsOn: companyExemptions.endsOn }).from(companyExemptions))
    expect(own).toEqual([{ endsOn: null }])
    await expect(withTenant(t.db, b.tenantId, ({ tx }) => tx.select({ reason: companyExemptions.reason }).from(companyExemptions))).rejects.toThrow()
    await expect(withTenant(t.db, b.tenantId, ({ tx }) => tx.update(companyExemptions).set({ endsOn: null }))).rejects.toThrow()
  })

  it('only the console grants one', async () => {
    const asCompany = await app.inject({ method: 'POST', url: `/api/platform/tenants/${b.tenantId}/exemption`, headers: await bearer(who.rosa), payload: { reason: 'demo', endsOn: null } })
    expect(asCompany.statusCode).toBe(403)
    expect(await new ExemptionService(t.db).view(b.tenantId)).toMatchObject({ reason: 'founder' })
  })
})

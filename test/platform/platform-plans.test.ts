// Vortomi's plans (console → Suscripciones → Planes, mockup web-34): only super admins with the
// second factor reach them; names are unique; suspending hides; a plan companies have is never
// deleted; no company can read the table.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformPlans } from '../../src/db/schema/index.ts'
import { PlanInUseError, type PlanSubscribers, PlatformPlanService } from '../../src/modules/platform/platform-plans.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let company: SeededTenant
const who = { yornel: '', laura: '', carlos: '' }

const equipo = {
  name: 'Equipo',
  description: 'Para equipos que atienden varios números.',
  priceCents: 7900,
  discounts: { '1': 0, '3': 5, '6': 10, '12': 20 },
  benefits: ['3 números · 5 usuarios', 'Reportes del equipo'],
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a: company } = await seedTwoTenants(t.db))
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  who.laura = await seedUser(t.db, 'Laura')
  await seedMembership(t.db, company.tenantId, who.laura, { role: 'admin' })
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, company.tenantId, who.carlos, { role: 'agent' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const console_ = async (method: Method, path: string, payload?: object, userId = who.yornel, aal: 'aal1' | 'aal2' = 'aal2') =>
  app.inject({ method, url: `/api/platform${path}`, headers: await bearer(userId, { aal }), ...(payload ? { payload } : {}) })

interface View {
  id: string
  name: string
  priceCents: number
  discounts: Record<string, number>
  benefits: string[]
  isActive: boolean
  companies: number
}

describe('who reaches them', () => {
  it('only a super admin, and only with the second factor', async () => {
    expect((await console_('GET', '/plans', undefined, who.laura)).json()).toEqual({ error: 'platform_admin_required' })
    expect((await console_('POST', '/plans', { ...equipo, isActive: true }, who.yornel, 'aal1')).json()).toEqual({ error: 'second_factor_required' })
  })
})

describe('Vortomi’s plans', () => {
  let id = ''

  it('creates one with its base price, discounts and benefits', async () => {
    const created = await console_('POST', '/plans', { ...equipo, isActive: true })
    expect(created.statusCode).toBe(201)
    const plan = created.json<View>()
    id = plan.id
    expect(plan).toMatchObject({ name: 'Equipo', priceCents: 7900, discounts: { '1': 0, '3': 5, '6': 10, '12': 20 }, isActive: true, companies: 0 })
    expect(plan.benefits).toEqual(['3 números · 5 usuarios', 'Reportes del equipo'])
  })

  it('refuses a name already used (any case or spaces), a zero price and a discount over 90 %', async () => {
    expect((await console_('POST', '/plans', { ...equipo, name: '  EQUIPO ', isActive: true })).json()).toEqual({ error: 'plan_name_taken' })
    expect((await console_('POST', '/plans', { ...equipo, name: 'Gratis', priceCents: 0, isActive: true })).json()).toEqual({ error: 'invalid_request' })
    const greedy = { ...equipo, name: 'Mitad', discounts: { ...equipo.discounts, '12': 95 }, isActive: true }
    expect((await console_('POST', '/plans', greedy)).json()).toEqual({ error: 'invalid_request' })
    const many = { ...equipo, name: 'Lleno', benefits: Array.from({ length: 13 }, (_, i) => `Beneficio ${i}`), isActive: true }
    expect((await console_('POST', '/plans', many)).json()).toEqual({ error: 'invalid_request' })
  })

  it('edits everything, but the switch stays where it was', async () => {
    const edited = await console_('PUT', `/plans/${id}`, { ...equipo, name: 'Equipo Plus', priceCents: 8900, benefits: [...equipo.benefits, 'Soporte prioritario'] })
    expect(edited.json<View>()).toMatchObject({ id, name: 'Equipo Plus', priceCents: 8900, isActive: true })
    expect(edited.json<View>().benefits).toHaveLength(3)
    expect((await console_('PUT', '/plans/00000000-0000-4000-8000-000000000000', equipo)).json()).toEqual({ error: 'plan_not_found' })
  })

  it('suspends and reactivates with the switch', async () => {
    expect((await console_('PUT', `/plans/${id}/active`, { isActive: false })).json<View>()).toMatchObject({ isActive: false })
    expect((await console_('GET', '/plans')).json<{ items: View[] }>().items[0]).toMatchObject({ id, isActive: false })
    expect((await console_('PUT', `/plans/${id}/active`, { isActive: true })).json<View>()).toMatchObject({ isActive: true })
  })

  it('deletes a plan no company has', async () => {
    expect((await console_('DELETE', `/plans/${id}`)).statusCode).toBe(204)
    expect((await console_('GET', '/plans')).json<{ items: View[] }>().items).toEqual([])
    expect((await console_('DELETE', `/plans/${id}`)).json()).toEqual({ error: 'plan_not_found' })
  })

  it('stays apart from every company: not readable from their scope', async () => {
    await expect(withTenant(t.db, company.tenantId, ({ tx }) => tx.select().from(platformPlans))).rejects.toThrow()
  })
})

describe('a plan companies are on', () => {
  it('shows how many, and is never deleted: only suspended', async () => {
    const subscribed = new Set<string>()
    const subscribers: PlanSubscribers = { count: (ids) => Promise.resolve(new Map(ids.filter((i) => subscribed.has(i)).map((i) => [i, 2]))) }
    const plans = new PlatformPlanService(t.db, subscribers)
    const plan = await plans.create({ ...equipo, name: 'Con empresas', isActive: true })
    subscribed.add(plan.id)
    expect((await plans.list()).find((p) => p.id === plan.id)?.companies).toBe(2)
    await expect(plans.remove(plan.id)).rejects.toBeInstanceOf(PlanInUseError)
    expect(await plans.setActive(plan.id, false)).toMatchObject({ isActive: false, companies: 2 })
  })
})

describe('what a company sees (Suscripción → Planes)', () => {
  const panel = async (userId: string, tenantId = company.tenantId) =>
    app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/plans`, headers: await bearer(userId) })

  it('its admins read the active plans only, without counts or switches', async () => {
    const shown = (await console_('POST', '/plans', { ...equipo, name: 'Visible', isActive: true })).json<View>()
    await console_('POST', '/plans', { ...equipo, name: 'Oculto', isActive: false })
    const read = await panel(who.laura)
    expect(read.statusCode).toBe(200)
    const items = read.json<{ items: Record<string, unknown>[] }>().items
    expect(items.map((p) => p.name)).toContain('Visible')
    expect(items.map((p) => p.name)).not.toContain('Oculto')
    const visible = items.find((p) => p.id === shown.id)!
    expect(visible).toMatchObject({ name: 'Visible', priceCents: 7900, discounts: equipo.discounts, benefits: equipo.benefits })
    expect(visible).not.toHaveProperty('companies')
    expect(visible).not.toHaveProperty('isActive')
  })

  it('agents and other companies do not', async () => {
    expect((await panel(who.carlos)).json()).toEqual({ error: 'admin_required' })
    expect((await panel(who.yornel)).json()).toEqual({ error: 'not_a_member' })
  })
})

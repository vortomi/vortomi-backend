// The welcome (block C): three closed answers prepare a starting point for the business type.
// It only adds what is missing, never touches what the company has, is for admins, and
// «Otro» keeps the text for our team, who can turn it into a new type of the list.
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tenantSettings, tenants } from '../../src/db/schema/index.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '', yornel: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  who.yornel = await seedUser(t.db, 'Yornel', 'super_admin')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const ALL = ['workMode', 'saleDefaults', 'categories', 'productFields', 'contactFields', 'variantTypes', 'tags']
const autoParts = { businessType: 'auto_parts', sells: 'products', sellMethod: 'unit' }

describe('the list of business types', () => {
  it('anyone signed in reads it, in the welcome order, «Otro» last', async () => {
    const items = (await app.inject({ method: 'GET', url: '/api/business-types', headers: await bearer(who.carlos) })).json<{ items: { code: string }[] }>().items
    expect(items[0]).toEqual({ code: 'auto_parts', label: 'Repuestos y autopartes', icon: 'car' })
    expect(items.at(-1)?.code).toBe('other')
    expect(items).toHaveLength(11)
  })
})

describe('the welcome', () => {
  it('starts unanswered; everyone reads it, only admins answer', async () => {
    expect((await call(who.carlos, 'GET', '/setup')).json()).toEqual({ businessType: null, businessTypeOther: '', sells: null, sellMethod: null, completedAt: null })
    expect((await call(who.carlos, 'POST', '/setup/plan', autoParts)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/setup/plan', { ...autoParts, businessType: 'bakery_x' })).json()).toEqual({ error: 'unknown_business_type' })
    expect((await call(who.laura, 'POST', '/setup/plan', { ...autoParts, businessType: 'other' })).statusCode).toBe(400)
  })

  it('the plan marks what the company already has', async () => {
    await call(who.laura, 'POST', '/inventory/categories', { name: 'frenos' })
    const plan = (await call(who.laura, 'POST', '/setup/plan', autoParts)).json<{ categories: { name: string; exists: boolean }[]; workMode: unknown; saleDefaults: unknown }>()
    expect(plan.workMode).toBeNull()
    expect(plan.saleDefaults).toEqual({ defaultSaleUnit: 'unit', defaultStockMode: 'units' })
    expect(plan.categories.slice(0, 2)).toEqual([
      { name: 'Frenos', detail: '', exists: true },
      { name: 'Filtros', detail: '', exists: false },
    ])
  })

  it('applies only the parts kept, adds what is missing and closes the welcome', async () => {
    const applied = (await call(who.laura, 'POST', '/setup/apply', { ...autoParts, include: ['categories', 'productFields', 'tags'] })).json<{
      created: Record<string, number>
      status: { businessType: string; completedAt: string | null }
    }>()
    expect(applied.created).toEqual({ categories: 4, productFields: 3, contactFields: 0, variantTypes: 0, tags: 3 })
    expect(applied.status).toMatchObject({ businessType: 'auto_parts' })
    expect(applied.status.completedAt).not.toBeNull()
    const categories = (await call(who.laura, 'GET', '/inventory/categories')).json<{ items: { name: string }[] }>().items.map((c) => c.name)
    expect(categories).toContain('frenos')
    expect(categories).not.toContain('Frenos')
    const fields = (await call(who.laura, 'GET', '/custom-fields?entity=product')).json<{ items: { label: string; categoryIds: string[] }[] }>().items
    expect(fields.find((f) => f.label === 'Lado')?.categoryIds).toHaveLength(2)
    expect((await call(who.laura, 'GET', '/custom-fields?entity=contact')).json<{ items: unknown[] }>().items).toEqual([])
  })

  it('running it again adds nothing twice', async () => {
    const again = (await call(who.laura, 'POST', '/setup/apply', { ...autoParts, include: ALL })).json<{ created: Record<string, number> }>()
    expect(again.created).toEqual({ categories: 0, productFields: 0, contactFields: 2, variantTypes: 1, tags: 0 })
    const [settings] = await t.db.select({ unit: tenantSettings.defaultSaleUnit }).from(tenantSettings).where(eq(tenantSettings.tenantId, a.tenantId))
    expect(settings?.unit).toBe('unit')
  })

  it('a company that only attends hides inventory and pipeline, and prepares no products', async () => {
    const answers = { businessType: 'health', sells: 'none', sellMethod: 'time' }
    const plan = (await call(who.pedro, 'POST', '/setup/plan', answers, b.tenantId)).json<{ workMode: string; categories: unknown[] }>()
    expect(plan).toMatchObject({ workMode: 'support_only', categories: [] })
    await call(who.pedro, 'POST', '/setup/apply', { ...answers, include: ALL }, b.tenantId)
    expect((await call(who.pedro, 'GET', '/settings', undefined, b.tenantId)).json()).toMatchObject({ workMode: 'support_only' })
    expect((await call(who.pedro, 'GET', '/inventory/categories', undefined, b.tenantId)).json<{ items: unknown[] }>().items).toEqual([])
  })

  it('«Lo hago después» closes it without answers', async () => {
    await t.db.update(tenants).set({ setupCompletedAt: null, businessType: null }).where(eq(tenants.id, b.tenantId))
    const skipped = (await call(who.pedro, 'POST', '/setup/skip', undefined, b.tenantId)).json<{ businessType: null; completedAt: string }>()
    expect(skipped.businessType).toBeNull()
    expect(skipped.completedAt).not.toBeNull()
  })
})

describe('«Otro» and our console', () => {
  const console = async (method: 'GET' | 'POST', path: string, payload?: object) =>
    app.inject({ method, url: `/api/platform${path}`, headers: await bearer(who.yornel, { aal: 'aal2' }), ...(payload ? { payload } : {}) })

  it('keeps what was written for our team, who turns it into a type of the list', async () => {
    const answers = { businessType: 'other', businessTypeOther: 'Óptica', sells: 'products', sellMethod: 'unit', include: [] }
    await call(who.laura, 'POST', '/setup/apply', answers)
    await call(who.pedro, 'POST', '/setup/apply', { ...answers, businessTypeOther: 'optica ' }, b.tenantId)
    expect((await call(who.laura, 'POST', '/setup/plan', answers)).statusCode).toBe(200)

    expect((await app.inject({ method: 'GET', url: '/api/platform/business-types/unclassified', headers: await bearer(who.laura) })).statusCode).toBe(403)
    const groups = (await console('GET', '/business-types/unclassified')).json<{ items: { text: string; tenants: { id: string }[] }[] }>().items
    expect(groups.map((g) => g.text)).toEqual(['Óptica'])
    expect(groups[0]!.tenants.map((tenant) => tenant.id).sort()).toEqual([a.tenantId, b.tenantId].sort())

    const created = await console('POST', '/business-types', { label: 'Óptica', tenantIds: [a.tenantId, b.tenantId] })
    expect(created.json()).toEqual({ code: 'optica', label: 'Óptica', icon: 'tag' })
    expect((await call(who.laura, 'GET', '/setup')).json()).toMatchObject({ businessType: 'optica', businessTypeOther: '' })
    expect((await console('GET', '/business-types/unclassified')).json()).toEqual({ items: [] })
    expect((await console('POST', '/business-types', { label: 'óptica' })).json()).toEqual({ error: 'business_type_exists' })
  })
})

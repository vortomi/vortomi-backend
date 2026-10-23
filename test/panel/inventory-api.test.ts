// Inventory: stock only moves through immutable movements, the last unit cannot be
// sold twice, and nothing of one company's catalog reaches another.
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { productVariants, stockMovements } from '../../src/db/schema/index.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
let variantId: string
const who = { laura: '', carlos: '', pedro: '' }

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const pads = { name: 'Pastillas de freno', stockMode: 'units', variants: [{ name: 'Bosch', sku: 'PF-BOSCH', priceCents: 3850, lowStockThreshold: 2, initialStock: 3 }] }
const variant = async (userId = who.carlos) =>
  (await call(userId, 'GET', '/inventory/products')).json<{ items: { variants: Record<string, unknown>[] }[] }>().items[0]!.variants[0]!

describe('catalog', () => {
  it('admins create products; the opening stock is an initial movement', async () => {
    expect((await call(who.carlos, 'POST', '/inventory/products', pads)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/inventory/products', pads)).statusCode).toBe(201)
    const created = await variant()
    variantId = created['id'] as string
    expect(created).toMatchObject({ sku: 'PF-BOSCH', priceCents: 3850, onHand: 3, reserved: 0, availableUnits: 3 })
    const history = (await call(who.carlos, 'GET', `/inventory/variants/${variantId}/movements`)).json<{ items: { kind: string; quantity: number }[] }>().items
    expect(history).toEqual([expect.objectContaining({ kind: 'initial', quantity: 3 })])
  })

  it('the SKU is unique per company, ignoring case, but two companies may share one', async () => {
    const again = { ...pads, variants: [{ ...pads.variants[0]!, sku: 'pf-bosch' }] }
    expect((await call(who.laura, 'POST', '/inventory/products', again)).json()).toEqual({ error: 'sku_taken' })
    expect((await call(who.pedro, 'POST', '/inventory/products', pads, b.tenantId)).statusCode).toBe(201)
    expect((await call(who.pedro, 'GET', '/inventory/products', undefined, b.tenantId)).json<{ items: unknown[] }>().items).toHaveLength(1)
  })
})

describe('editing a product', () => {
  it('admins rename it and add variants; the new opening stock is a movement too', async () => {
    const productId = (await call(who.carlos, 'GET', '/inventory/products')).json<{ items: { id: string }[] }>().items[0]!.id
    const rename = { name: 'Pastillas de freno delanteras', categoryId: null, description: 'Juego de 4' }
    expect((await call(who.carlos, 'PUT', `/inventory/products/${productId}`, rename)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'PUT', `/inventory/products/${productId}`, rename)).statusCode).toBe(204)

    const brembo = { name: 'Brembo', sku: 'PF-BREMBO', priceCents: 4500, initialStock: 4 }
    expect((await call(who.carlos, 'POST', `/inventory/products/${productId}/variants`, brembo)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', `/inventory/products/${productId}/variants`, brembo)).statusCode).toBe(201)
    expect((await call(who.laura, 'POST', `/inventory/products/${productId}/variants`, { ...brembo, sku: 'pf-brembo' })).json()).toEqual({ error: 'sku_taken' })

    const product = (await call(who.carlos, 'GET', '/inventory/products')).json<{ items: { name: string; variants: { sku: string; onHand: number }[] }[] }>().items[0]!
    expect(product.name).toBe('Pastillas de freno delanteras')
    expect(product.variants.find((v) => v.sku === 'PF-BREMBO')).toMatchObject({ onHand: 4 })
  })

  it('another company cannot edit it nor add variants to it', async () => {
    const productId = (await call(who.carlos, 'GET', '/inventory/products')).json<{ items: { id: string }[] }>().items[0]!.id
    const rename = { name: 'Robado', categoryId: null, description: '' }
    expect((await call(who.pedro, 'PUT', `/inventory/products/${productId}`, rename, b.tenantId)).json()).toEqual({ error: 'inventory_item_not_found' })
    const extra = { name: 'X', sku: 'X-1', priceCents: 1 }
    expect((await call(who.pedro, 'POST', `/inventory/products/${productId}/variants`, extra, b.tenantId)).json()).toEqual({ error: 'inventory_item_not_found' })
  })
})

describe('categories', () => {
  const productId = async () => (await call(who.carlos, 'GET', '/inventory/products')).json<{ items: { id: string }[] }>().items[0]!.id

  it('admins keep the list; names are unique per company ignoring case', async () => {
    expect((await call(who.carlos, 'POST', '/inventory/categories', { name: 'Frenos' })).json()).toEqual({ error: 'admin_required' })
    const created = await call(who.laura, 'POST', '/inventory/categories', { name: 'Frenos' })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Frenos', productCount: 0 })
    expect((await call(who.laura, 'POST', '/inventory/categories', { name: 'frenos' })).json()).toEqual({ error: 'category_name_taken' })
    expect((await call(who.pedro, 'POST', '/inventory/categories', { name: 'Frenos' }, b.tenantId)).statusCode).toBe(201)
  })

  it('a product picks one of its own company, and shows its name', async () => {
    const [frenos] = (await call(who.carlos, 'GET', '/inventory/categories')).json<{ items: { id: string }[] }>().items
    const fields = { name: 'Pastillas de freno delanteras', categoryId: frenos!.id, description: '' }
    expect((await call(who.laura, 'PUT', `/inventory/products/${await productId()}`, fields)).statusCode).toBe(204)
    const product = (await call(who.carlos, 'GET', '/inventory/products')).json<{ items: Record<string, unknown>[] }>().items[0]!
    expect(product).toMatchObject({ categoryId: frenos!.id, category: 'Frenos' })
    expect((await call(who.carlos, 'GET', '/inventory/categories')).json<{ items: unknown[] }>().items).toEqual([expect.objectContaining({ productCount: 1 })])

    const theirs = (await call(who.pedro, 'GET', '/inventory/categories', undefined, b.tenantId)).json<{ items: { id: string }[] }>().items[0]!
    const stolen = { ...fields, categoryId: theirs.id }
    expect((await call(who.laura, 'PUT', `/inventory/products/${await productId()}`, stolen)).json()).toEqual({ error: 'category_not_found' })
  })

  it('a category with products cannot be deleted; an empty one can', async () => {
    const [frenos] = (await call(who.carlos, 'GET', '/inventory/categories')).json<{ items: { id: string }[] }>().items
    expect((await call(who.laura, 'DELETE', `/inventory/categories/${frenos!.id}`)).json()).toEqual({ error: 'category_in_use' })
    const empty = (await call(who.laura, 'POST', '/inventory/categories', { name: 'Suspensión' })).json<{ id: string }>()
    expect((await call(who.laura, 'PUT', `/inventory/categories/${empty.id}`, { name: 'Suspensión y dirección' })).json()).toMatchObject({ name: 'Suspensión y dirección' })
    expect((await call(who.laura, 'DELETE', `/inventory/categories/${empty.id}`)).statusCode).toBe(204)
    expect((await call(who.pedro, 'DELETE', `/inventory/categories/${frenos!.id}`, undefined, b.tenantId)).json()).toEqual({ error: 'category_not_found' })
  })
})

describe('stock movements', () => {
  it('an agent sells and takes back; the count follows', async () => {
    expect((await call(who.carlos, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'sale', quantity: -2, reason: 'Pedido 1043' })).json()).toMatchObject({
      onHand: 1,
    })
    expect((await call(who.carlos, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'return', quantity: 1 })).json()).toMatchObject({ onHand: 2 })
  })

  it('purchases, adjustments and losses are for admins; the sign must match the kind', async () => {
    expect((await call(who.carlos, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'purchase', quantity: 10 })).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'sale', quantity: 1 })).json()).toEqual({ error: 'invalid_movement' })
    expect((await call(who.laura, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'initial', quantity: 1 })).statusCode).toBe(400)
  })

  it('cannot sell more than there is, and a failed sale leaves no trace', async () => {
    const before = (await t.db.select().from(stockMovements)).length
    expect((await call(who.carlos, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'sale', quantity: -3 })).json()).toEqual({
      error: 'insufficient_stock',
    })
    expect((await t.db.select().from(stockMovements)).length).toBe(before)
    expect(await variant()).toMatchObject({ onHand: 2 })
  })

  it('two sales racing for the last units: one wins, the other fails', async () => {
    const sell = () => call(who.carlos, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'sale', quantity: -2 })
    const results = await Promise.all([sell(), sell()])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(await variant()).toMatchObject({ onHand: 0 })
  })
})

describe('what the database guarantees', () => {
  it('company code cannot write the count directly, nor rewrite history', async () => {
    const forged = withTenant(t.db, a.tenantId, ({ tx }) => tx.update(productVariants).set({ onHand: 999 }).where(eq(productVariants.id, variantId)))
    expect(await dbError(forged)).toMatch(/permission denied/)
    const rewrite = t.db.execute(sql`update stock_movements set quantity = 100`)
    expect(await dbError(rewrite)).toMatch(/append-only/)
  })

  it('another company cannot move this stock', async () => {
    expect((await call(who.pedro, 'POST', `/inventory/variants/${variantId}/movements`, { kind: 'purchase', quantity: 5 }, b.tenantId)).json()).toEqual({
      error: 'inventory_item_not_found',
    })
  })
})

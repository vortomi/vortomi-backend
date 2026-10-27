// Variant types: a product's variants pick values of its type instead of typing names,
// the database keeps every value inside its own type and company, and nothing in use is deleted.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '' }

interface Type {
  id: string
  name: string
  options: { id: string; value: string; variantCount: number }[]
}

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
const types = async (userId = who.laura, tenantId = a.tenantId) => (await call(userId, 'GET', '/inventory/variant-types', undefined, tenantId)).json<{ items: Type[] }>().items
const products = async () =>
  (await call(who.laura, 'GET', '/inventory/products')).json<{ items: { id: string; variantTypeIds: string[]; variants: { id: string; name: string; optionIds: string[] }[] }[] }>().items

describe('the list of types and values', () => {
  it('admins keep it; names are unique per company and values per type, ignoring case', async () => {
    expect((await call(who.carlos, 'POST', '/inventory/variant-types', { name: 'Marca' })).json()).toEqual({ error: 'admin_required' })
    const marca = (await call(who.laura, 'POST', '/inventory/variant-types', { name: 'Marca' })).json<Type>()
    expect((await call(who.laura, 'POST', '/inventory/variant-types', { name: 'marca' })).json()).toEqual({ error: 'variant_type_name_taken' })
    for (const value of ['Bosch', 'Brembo']) {
      expect((await call(who.laura, 'POST', `/inventory/variant-types/${marca.id}/options`, { value })).statusCode).toBe(201)
    }
    expect((await call(who.laura, 'POST', `/inventory/variant-types/${marca.id}/options`, { value: 'BOSCH' })).json()).toEqual({ error: 'variant_option_taken' })
    expect(await types(who.carlos)).toEqual([expect.objectContaining({ name: 'Marca', options: [expect.objectContaining({ value: 'Bosch' }), expect.objectContaining({ value: 'Brembo' })] })])
  })

  it('another company neither sees it nor adds values to it', async () => {
    const [marca] = await types()
    expect(await types(who.pedro, b.tenantId)).toEqual([])
    expect((await call(who.pedro, 'POST', `/inventory/variant-types/${marca!.id}/options`, { value: 'X' }, b.tenantId)).json()).toEqual({ error: 'variant_type_not_found' })
  })
})

describe('products with a type', () => {
  it('each variant picks a value of the type, named after it, and never the same one twice', async () => {
    const [marca] = await types()
    const [bosch, brembo] = marca!.options
    const product = {
      name: 'Pastillas de freno',
      stockMode: 'units',
      variantTypeIds: [marca!.id],
      variants: [
        { optionIds: [bosch!.id], sku: 'PF-BOS', priceCents: 3800, initialStock: 2 },
        { optionIds: [brembo!.id], sku: 'PF-BRE', priceCents: 4500 },
      ],
    }
    expect((await call(who.laura, 'POST', '/inventory/products', product)).statusCode).toBe(201)
    const [created] = await products()
    expect(created!.variants.map((v) => v.name).sort()).toEqual(['Bosch', 'Brembo'])

    const again = { optionIds: [bosch!.id], sku: 'PF-BOS-2', priceCents: 1 }
    expect((await call(who.laura, 'POST', `/inventory/products/${created!.id}/variants`, again)).json()).toEqual({ error: 'variant_option_repeated' })
  })

  it('refuses values of another type, and options on a product without type', async () => {
    const talla = (await call(who.laura, 'POST', '/inventory/variant-types', { name: 'Talla' })).json<Type>()
    const m = (await call(who.laura, 'POST', `/inventory/variant-types/${talla.id}/options`, { value: 'M' })).json<{ id: string }>()
    const [product] = await products()
    expect((await call(who.laura, 'POST', `/inventory/products/${product!.id}/variants`, { optionIds: [m.id], sku: 'PF-M', priceCents: 1 })).json()).toEqual({
      error: 'variant_option_not_found',
    })
    const free = { name: 'Filtro', stockMode: 'units', variants: [{ optionIds: [m.id], sku: 'FI-1', priceCents: 1 }] }
    expect((await call(who.laura, 'POST', '/inventory/products', free)).json()).toEqual({ error: 'invalid_variant' })
  })

  it('renaming a value renames its variants; the product type cannot change while values are in use', async () => {
    const [marca] = await types()
    const bosch = marca!.options.find((o) => o.value === 'Bosch')!
    expect((await call(who.laura, 'PUT', `/inventory/variant-options/${bosch.id}`, { value: 'Bosch Original' })).statusCode).toBe(200)
    const [product] = await products()
    expect(product!.variants.map((v) => v.name).sort()).toEqual(['Bosch Original', 'Brembo'])

    const talla = (await types()).find((ty) => ty.name === 'Talla')!
    const change = { name: 'Pastillas de freno', categoryId: null, variantTypeIds: [talla.id], description: '' }
    expect((await call(who.laura, 'PUT', `/inventory/products/${product!.id}`, change)).json()).toEqual({ error: 'variant_type_locked' })
  })

  it('a value or a type in use cannot be deleted; unused ones can', async () => {
    const [marca] = await types()
    const used = marca!.options[0]!
    expect(used.variantCount).toBe(1)
    expect((await call(who.laura, 'DELETE', `/inventory/variant-options/${used.id}`)).json()).toEqual({ error: 'variant_option_in_use' })
    expect((await call(who.laura, 'DELETE', `/inventory/variant-types/${marca!.id}`)).json()).toEqual({ error: 'variant_type_in_use' })

    const talla = (await types()).find((ty) => ty.name === 'Talla')!
    expect((await call(who.laura, 'DELETE', `/inventory/variant-types/${talla.id}`)).statusCode).toBe(204)
    expect((await types()).map((ty) => ty.name)).toEqual(['Marca'])
  })
})

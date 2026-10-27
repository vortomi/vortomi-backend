// How products are sold (unit, kilo, metre...) and combined variants (Talla x Color): fractions
// only where the unit takes them, minimums and steps from the offered lists, each combination
// once per product, and the types locked while their values are in use.
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
const who = { laura: '', carlos: '' }

interface Variant {
  id: string
  name: string
  optionIds: string[]
  onHand: number
  lowStockThreshold: number
}
interface Product {
  id: string
  name: string
  saleUnit: string
  minQuantity: number
  quantityStep: number
  variantTypeIds: string[]
  variants: Variant[]
}
interface Type {
  id: string
  name: string
  options: { id: string; value: string; variantCount: number }[]
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos)
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  app.inject({ method, url: `/api/tenants/${a.tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const product = async (name: string) =>
  (await call(who.laura, 'GET', '/inventory/products')).json<{ items: Product[] }>().items.find((p) => p.name === name)!
const types = async () => (await call(who.laura, 'GET', '/inventory/variant-types')).json<{ items: Type[] }>().items

describe('how a product is sold', () => {
  const cheese = {
    name: 'Queso blanco',
    stockMode: 'units',
    saleUnit: 'kg',
    minQuantity: 0.25,
    quantityStep: 0.25,
    variants: [{ name: 'Única', sku: 'QB-1', priceCents: 450, initialStock: 12.5, lowStockThreshold: 2.5 }],
  }

  it('by default, by the unit, one at a time', async () => {
    const created = await call(who.laura, 'POST', '/inventory/products', { name: 'Filtro', stockMode: 'units', variants: [{ name: 'Única', sku: 'FI-1', priceCents: 900 }] })
    expect(created.statusCode).toBe(201)
    expect(await product('Filtro')).toMatchObject({ saleUnit: 'unit', minQuantity: 1, quantityStep: 1, variantTypeIds: [] })
  })

  it('by the kilo: stock, thresholds and sales in fractions', async () => {
    expect((await call(who.laura, 'POST', '/inventory/products', cheese)).statusCode).toBe(201)
    const [variant] = (await product('Queso blanco')).variants
    expect(variant).toMatchObject({ onHand: 12.5, lowStockThreshold: 2.5 })
    const sold = await call(who.carlos, 'POST', `/inventory/variants/${variant!.id}/movements`, { kind: 'sale', quantity: -0.75, reason: 'Pedido 7' })
    expect(sold.json()).toMatchObject({ onHand: 11.75, availableUnits: 11.75 })
    const history = (await call(who.carlos, 'GET', `/inventory/variants/${variant!.id}/movements`)).json<{ items: { quantity: number }[] }>().items
    expect(history.map((m) => m.quantity)).toEqual([-0.75, 12.5])
  })

  it('no fractions of what counts whole, and never more than 3 decimals', async () => {
    const filter = (await product('Filtro')).variants[0]!
    expect((await call(who.laura, 'POST', `/inventory/variants/${filter.id}/movements`, { kind: 'purchase', quantity: 1.5 })).json()).toEqual({ error: 'invalid_quantity' })
    const halfStock = { name: 'Tornillo', stockMode: 'units', variants: [{ name: 'Única', sku: 'TO-1', priceCents: 10, initialStock: 0.5 }] }
    expect((await call(who.laura, 'POST', '/inventory/products', halfStock)).json()).toEqual({ error: 'invalid_quantity' })
    const cheeseVariant = (await product('Queso blanco')).variants[0]!
    expect((await call(who.laura, 'POST', `/inventory/variants/${cheeseVariant.id}/movements`, { kind: 'purchase', quantity: 1.0005 })).statusCode).toBe(400)
  })

  it('minimums and steps come from the offered lists and fit the unit', async () => {
    const base = { ...cheese, name: 'Tela', variants: [{ name: 'Única', sku: 'TE-1', priceCents: 300 }] }
    expect((await call(who.laura, 'POST', '/inventory/products', { ...base, saleUnit: 'unit', minQuantity: 1, quantityStep: 0.5 })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '/inventory/products', { ...base, saleUnit: 'm', minQuantity: 0.1, quantityStep: 0.25 })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '/inventory/products', { ...base, saleUnit: 'm', minQuantity: 0.3, quantityStep: 0.1 })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '/inventory/products', { ...base, saleUnit: 'liter', minQuantity: 1, quantityStep: 1 })).statusCode).toBe(400)
    expect((await call(who.laura, 'POST', '/inventory/products', { ...base, saleUnit: 'm', minQuantity: 0.5, quantityStep: 0.5 })).statusCode).toBe(201)
  })

  it('cannot switch to a unit that counts whole while some count is a fraction', async () => {
    const { id } = await product('Queso blanco')
    const fields = { name: 'Queso blanco', categoryId: null, description: '', variantTypeIds: [] }
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, { ...fields, saleUnit: 'unit', minQuantity: 1, quantityStep: 1 })).json()).toEqual({
      error: 'fractional_stock',
    })
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, { ...fields, saleUnit: 'kg', minQuantity: 0.5, quantityStep: 0.5 })).statusCode).toBe(204)
    expect(await product('Queso blanco')).toMatchObject({ minQuantity: 0.5, quantityStep: 0.5 })
  })
})

describe('combined variants', () => {
  let talla: Type
  let color: Type
  const value = (type: Type, text: string) => type.options.find((o) => o.value === text)!.id

  beforeAll(async () => {
    for (const [name, values] of [
      ['Talla', ['S', 'M']],
      ['Color', ['Rojo', 'Azul']],
    ] as const) {
      const type = (await call(who.laura, 'POST', '/inventory/variant-types', { name })).json<Type>()
      for (const v of values) await call(who.laura, 'POST', `/inventory/variant-types/${type.id}/options`, { value: v })
    }
    const all = await types()
    talla = all.find((ty) => ty.name === 'Talla')!
    color = all.find((ty) => ty.name === 'Color')!
  })

  it('each combination of values is a variant named after them', async () => {
    const variants = ['S', 'M'].flatMap((size) =>
      ['Rojo', 'Azul'].map((colour) => ({ optionIds: [value(talla, size), value(color, colour)], sku: `CA-${size}-${colour}`, priceCents: 1500, initialStock: 3 })),
    )
    const shirt = { name: 'Camisa', stockMode: 'units', variantTypeIds: [talla.id, color.id], variants }
    expect((await call(who.laura, 'POST', '/inventory/products', shirt)).statusCode).toBe(201)
    const created = await product('Camisa')
    expect(created.variantTypeIds).toEqual([talla.id, color.id])
    expect(created.variants.map((v) => v.name).sort()).toEqual(['M / Azul', 'M / Rojo', 'S / Azul', 'S / Rojo'])
    expect(created.variants.find((v) => v.name === 'S / Rojo')!.optionIds).toEqual([value(talla, 'S'), value(color, 'Rojo')])
    expect((await types()).find((ty) => ty.name === 'Color')!.options.every((o) => o.variantCount === 2)).toBe(true)
  })

  it('never the same combination twice, never half of one, never out of order', async () => {
    const { id } = await product('Camisa')
    const variant = (optionIds: string[], sku: string) => call(who.laura, 'POST', `/inventory/products/${id}/variants`, { optionIds, sku, priceCents: 1 })
    expect((await variant([value(talla, 'S'), value(color, 'Rojo')], 'CA-X1')).json()).toEqual({ error: 'variant_option_repeated' })
    expect((await variant([value(talla, 'S')], 'CA-X2')).json()).toEqual({ error: 'invalid_variant' })
    expect((await variant([value(color, 'Rojo'), value(talla, 'S')], 'CA-X3')).json()).toEqual({ error: 'variant_option_not_found' })
    const repeated = { name: 'Gorra', stockMode: 'units', variantTypeIds: [talla.id, talla.id], variants: [{ name: 'Única', sku: 'GO-1', priceCents: 1 }] }
    expect((await call(who.laura, 'POST', '/inventory/products', repeated)).statusCode).toBe(400)
  })

  it('renaming a value renames every combination that uses it', async () => {
    expect((await call(who.laura, 'PUT', `/inventory/variant-options/${value(color, 'Rojo')}`, { value: 'Rojo vino' })).statusCode).toBe(200)
    expect((await product('Camisa')).variants.map((v) => v.name).sort()).toEqual(['M / Azul', 'M / Rojo vino', 'S / Azul', 'S / Rojo vino'])
  })

  it('the types cannot change while values are in use, nor a value or type in use be deleted', async () => {
    const { id } = await product('Camisa')
    const fields = { name: 'Camisa', categoryId: null, description: '', saleUnit: 'unit', minQuantity: 1, quantityStep: 1 }
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, { ...fields, variantTypeIds: [color.id, talla.id] })).json()).toEqual({ error: 'variant_type_locked' })
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, { ...fields, variantTypeIds: [talla.id] })).json()).toEqual({ error: 'variant_type_locked' })
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, { ...fields, variantTypeIds: [talla.id, color.id] })).statusCode).toBe(204)
    expect((await call(who.laura, 'DELETE', `/inventory/variant-options/${value(color, 'Azul')}`)).json()).toEqual({ error: 'variant_option_in_use' })
    expect((await call(who.laura, 'DELETE', `/inventory/variant-types/${color.id}`)).json()).toEqual({ error: 'variant_type_in_use' })
  })
})

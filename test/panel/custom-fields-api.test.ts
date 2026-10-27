// The company's own data about its products and customers: admins define the fields, every
// value is checked against them, removing a field or option removes its answers, notes typed
// before fields existed can be turned into one, and nothing crosses to another company.
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts } from '../../src/db/schema/index.ts'
import { buildTestApp } from '../helpers/app.ts'
import { bearer, seedMembership, seedUser } from '../helpers/auth.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let app: FastifyInstance
let a: SeededTenant
let b: SeededTenant
const who = { laura: '', carlos: '', pedro: '' }

interface Field {
  id: string
  label: string
  kind: string
  required: boolean
  options: { id: string; value: string }[]
  categoryIds: string[]
}
interface Product {
  id: string
  name: string
  customValues: Record<string, unknown>
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  who.laura = await seedUser(t.db, 'Laura')
  who.carlos = await seedUser(t.db, 'Carlos')
  who.pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, who.laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, who.carlos, { channelAccountIds: [a.channelAccountId] })
  await seedMembership(t.db, b.tenantId, who.pedro, { role: 'admin' })
  app = await buildTestApp(t.db)
})

afterAll(async () => {
  await app.close()
  await t.close()
})

const call = async (userId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, tenantId = a.tenantId) =>
  app.inject({ method, url: `/api/tenants/${tenantId}${path}`, headers: await bearer(userId), ...(payload ? { payload } : {}) })
const fields = async (entity: 'product' | 'contact', userId = who.laura) =>
  (await call(userId, 'GET', `/custom-fields?entity=${entity}`)).json<{ items: Field[] }>().items
const product = async (name: string) => (await call(who.laura, 'GET', '/inventory/products')).json<{ items: Product[] }>().items.find((p) => p.name === name)!
const option = (field: Field, value: string) => field.options.find((o) => o.value === value)!.id

let frenos = ''
let electrico = ''

describe('defining fields', () => {
  it('admins define them; everyone reads them', async () => {
    frenos = (await call(who.laura, 'POST', '/inventory/categories', { name: 'Frenos' })).json<{ id: string }>().id
    electrico = (await call(who.laura, 'POST', '/inventory/categories', { name: 'Eléctrico' })).json<{ id: string }>().id
    const fits = { entity: 'product', label: 'Sirve para', kind: 'multi_choice', required: true, options: ['Corolla 2015', 'Yaris 2018'], categoryIds: [frenos] }
    expect((await call(who.carlos, 'POST', '/custom-fields', fits)).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'POST', '/custom-fields', fits)).statusCode).toBe(201)
    await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'Marca', kind: 'choice', options: ['Bosch', 'Brembo'] })
    await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'Garantía (meses)', kind: 'number', categoryIds: [electrico] })
    expect((await fields('product', who.carlos)).map((f) => [f.label, f.kind, f.required])).toEqual([
      ['Sirve para', 'multi_choice', true],
      ['Marca', 'choice', false],
      ['Garantía (meses)', 'number', false],
    ])
  })

  it('refuses a repeated name, a list without options and options where none go', async () => {
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'marca', kind: 'text' })).json()).toEqual({ error: 'field_label_taken' })
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'Lado', kind: 'choice' })).json()).toEqual({ error: 'invalid_field' })
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'Notas', kind: 'text', options: ['x'] })).json()).toEqual({ error: 'invalid_field' })
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'contact', label: 'Zona', kind: 'text', categoryIds: [frenos] })).json()).toEqual({ error: 'invalid_field' })
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'product', label: 'Color', kind: 'text', categoryIds: [crypto.randomUUID()] })).json()).toEqual({ error: 'unknown_category' })
  })
})

describe('product values', () => {
  it('checked against the fields: options of their own list, required ones answered', async () => {
    const [fits, brand] = await fields('product')
    const base = { name: 'Pastillas', categoryId: frenos, stockMode: 'units', variants: [{ name: 'Única', sku: 'PF-1', priceCents: 3800 }] }
    expect((await call(who.laura, 'POST', '/inventory/products', base)).json()).toEqual({ error: 'invalid_field_value' })
    const wrongOption = { ...base, customValues: { [fits!.id]: [option(brand!, 'Bosch')] } }
    expect((await call(who.laura, 'POST', '/inventory/products', wrongOption)).json()).toEqual({ error: 'invalid_field_value' })
    const good = { ...base, customValues: { [fits!.id]: [option(fits!, 'Corolla 2015'), option(fits!, 'Corolla 2015')], [brand!.id]: option(brand!, 'Bosch') } }
    expect((await call(who.laura, 'POST', '/inventory/products', good)).statusCode).toBe(201)
    expect((await product('Pastillas')).customValues).toEqual({ [fits!.id]: [option(fits!, 'Corolla 2015')], [brand!.id]: option(brand!, 'Bosch') })
  })

  it('a field of another category is dropped, and a required one of another category is not asked', async () => {
    const [, , warranty] = await fields('product')
    const bulb = { name: 'Bombillo', categoryId: electrico, stockMode: 'units', variants: [{ name: 'Única', sku: 'BO-1', priceCents: 500 }], customValues: { [warranty!.id]: 6 } }
    expect((await call(who.laura, 'POST', '/inventory/products', bulb)).statusCode).toBe(201)
    expect((await product('Bombillo')).customValues).toEqual({ [warranty!.id]: 6 })
  })

  it('an update without values keeps them', async () => {
    const { id, customValues } = await product('Pastillas')
    const fields = { name: 'Pastillas', categoryId: frenos, description: 'Juego de 4', variantTypeIds: [], saleUnit: 'unit', minQuantity: 1, quantityStep: 1 }
    expect((await call(who.laura, 'PUT', `/inventory/products/${id}`, fields)).statusCode).toBe(204)
    expect((await product('Pastillas')).customValues).toEqual(customValues)
  })

  it('renaming an option keeps its answers; taking it off the list takes it off them', async () => {
    const [fits] = await fields('product')
    const corolla = option(fits!, 'Corolla 2015')
    const renamed = { label: 'Sirve para', required: false, categoryIds: [frenos], options: [{ id: corolla, value: 'Corolla 2015-2017' }, { value: 'Hilux 2020' }] }
    const saved = (await call(who.laura, 'PUT', `/custom-fields/${fits!.id}`, renamed)).json<Field>()
    expect(saved.options.map((o) => o.value)).toEqual(['Corolla 2015-2017', 'Hilux 2020'])
    expect((await product('Pastillas')).customValues[fits!.id]).toEqual([corolla])

    const dropped = { ...renamed, options: [{ value: 'Hilux 2020', id: saved.options[1]!.id }] }
    expect((await call(who.laura, 'PUT', `/custom-fields/${fits!.id}`, dropped)).statusCode).toBe(200)
    expect(fits!.id in (await product('Pastillas')).customValues).toBe(false)
  })

  it('deleting a field deletes its answers', async () => {
    const [, brand] = await fields('product')
    expect((await call(who.laura, 'DELETE', `/custom-fields/${brand!.id}`)).statusCode).toBe(204)
    expect((await product('Pastillas')).customValues).toEqual({})
  })
})

describe('customer values', () => {
  let contactId = ''

  it('required ones on a contact typed by hand; anyone who sees it answers them', async () => {
    const car = (await call(who.laura, 'POST', '/custom-fields', { entity: 'contact', label: 'Vehículo', kind: 'choice', required: true, options: ['Corolla 2015'] })).json<Field>()
    await call(who.laura, 'POST', '/custom-fields', { entity: 'contact', label: 'Cumpleaños', kind: 'date' })
    const contact = { channelAccountId: a.channelAccountId, waId: '584125550901' }
    expect((await call(who.carlos, 'POST', '/contacts', contact)).json()).toEqual({ error: 'invalid_field_value' })
    const created = await call(who.carlos, 'POST', '/contacts', { ...contact, customValues: { [car.id]: car.options[0]!.id } })
    contactId = created.json<{ id: string }>().id
    expect(created.json()).toMatchObject({ customValues: { [car.id]: car.options[0]!.id } })

    const [, birthday] = await fields('contact')
    const values = { [car.id]: car.options[0]!.id, [birthday!.id]: '1990-02-30' }
    expect((await call(who.carlos, 'PUT', `/contacts/${contactId}/custom-values`, { values })).json()).toEqual({ error: 'invalid_field_value' })
    values[birthday!.id] = '1990-03-14'
    expect((await call(who.carlos, 'PUT', `/contacts/${contactId}/custom-values`, { values })).statusCode).toBe(204)
    expect((await call(who.carlos, 'GET', `/contacts/${contactId}`)).json()).toMatchObject({ customValues: values })
  })

  it('a field of another company is refused, and that company cannot touch these fields', async () => {
    const theirs = (await call(who.pedro, 'POST', '/custom-fields', { entity: 'contact', label: 'Zona', kind: 'text' }, b.tenantId)).json<Field>()
    const [car] = await fields('contact')
    const values = { [car!.id]: car!.options[0]!.id, [theirs.id]: 'Valencia' }
    expect((await call(who.laura, 'PUT', `/contacts/${contactId}/custom-values`, { values })).json()).toEqual({ error: 'invalid_field_value' })
    expect((await call(who.pedro, 'DELETE', `/custom-fields/${car!.id}`, undefined, b.tenantId)).json()).toEqual({ error: 'custom_field_not_found' })
    expect(await fields('contact')).toHaveLength(2)
  })
})

describe('notes typed before the fields existed', () => {
  it('are grouped by name and moved into a text field in one go', async () => {
    const note = (label: string, value: string) => ({ key: label.toLowerCase().replace(/[^a-z]/g, '') || 'x', label, value })
    for (const [waId, attributes] of [
      ['584125550911', [note('Dirección', 'Av. Bolívar 12')]],
      ['584125550912', [note('direccion:', 'Calle 5')]],
      ['584125550913', [note('Color favorito', 'Azul')]],
    ] as const) {
      await t.db.insert(contacts).values({ tenantId: a.tenantId, channelAccountId: a.channelAccountId, waId, attributes: [...attributes] })
    }
    expect((await call(who.carlos, 'GET', '/custom-fields/notes')).json()).toEqual({ error: 'admin_required' })
    expect((await call(who.laura, 'GET', '/custom-fields/notes')).json<{ items: unknown[] }>().items).toEqual([
      { label: 'Dirección', count: 2 },
      { label: 'Color favorito', count: 1 },
    ])
    const result = (await call(who.laura, 'POST', '/custom-fields/notes/organize', { label: 'Dirección' })).json<{ field: Field; moved: number }>()
    expect(result).toMatchObject({ moved: 2, field: { label: 'Dirección', kind: 'text' } })
    const [moved] = await t.db.select({ customValues: contacts.customValues, attributes: contacts.attributes }).from(contacts).where(eq(contacts.waId, '584125550912'))
    expect(moved).toEqual({ customValues: { [result.field.id]: 'Calle 5' }, attributes: [] })
    expect((await call(who.laura, 'GET', '/custom-fields/notes')).json<{ items: { label: string }[] }>().items.map((n) => n.label)).toEqual(['Color favorito'])
  })
})

describe('limits', () => {
  it('at most 30 fields for customers', async () => {
    const existing = (await fields('contact')).length
    for (let i = existing; i < 30; i++) await call(who.laura, 'POST', '/custom-fields', { entity: 'contact', label: `Dato ${i}`, kind: 'text' })
    expect((await call(who.laura, 'POST', '/custom-fields', { entity: 'contact', label: 'Uno más', kind: 'text' })).json()).toEqual({ error: 'field_limit' })
  })
})

// The agent finds products the way customers write: «¿tienen golfeados?» is the «Golfeado» on the
// shelf (signs, plurals and accents aside), «cafe» is «Café con leche», and a greeting or a sentence
// full of «con», «para», «hay» finds nothing instead of half the catalog.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { productCategories, productVariants, products } from '../../src/db/schema/index.ts'
import { searchInventory, searchTerms } from '../../src/modules/agent/agent-catalog.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant

const names = async (query: string) => ((await searchInventory(t.db, a.tenantId, query, null)).products as { name: string }[]).map((p) => p.name).sort()

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
  const [panes] = await t.db.insert(productCategories).values({ tenantId: a.tenantId, name: 'Panes' }).returning({ id: productCategories.id })
  const shelf = [
    { name: 'Golfeado', description: 'De papelón con anís y queso.', categoryId: null },
    { name: 'Café con leche', description: 'Con o sin azúcar.', categoryId: null },
    { name: 'Pan francés (canilla)', description: 'Recién horneada.', categoryId: panes!.id },
    { name: 'Torta de chocolate (porción)', description: 'Húmeda, con ganache.', categoryId: null },
  ]
  for (const [index, item] of shelf.entries()) {
    const [product] = await t.db.insert(products).values({ tenantId: a.tenantId, stockMode: 'units', ...item }).returning({ id: products.id })
    await t.db.insert(productVariants).values({ tenantId: a.tenantId, productId: product!.id, name: 'Única', sku: `SKU-${index}`, priceCents: 150 })
  }
})

afterAll(async () => {
  await t.close()
})

describe('what is looked for in what the customer wrote', () => {
  it('drops signs, accents and filler words, and keeps a plural as its stem', () => {
    expect(searchTerms('Hola, ¿tienen golfeados?')).toEqual(['golfeado'])
    expect(searchTerms('¿Cuánto cuestan los cafés?')).toEqual(['caf'])
    expect(searchTerms('Quiero 2 panes')).toEqual(['2', 'pan'])
    expect(searchTerms('hola, buenas tardes')).toEqual([])
  })
})

describe('the agent searching the inventory', () => {
  it('finds a product written in plural, with signs around it', async () => {
    expect(await names('Hola, ¿tienen golfeados?')).toEqual(['Golfeado'])
  })

  it('finds it without the accents the product name has', async () => {
    expect(await names('un cafe por favor')).toEqual(['Café con leche'])
  })

  it('finds products by their category, in plural', async () => {
    expect(await names('¿Qué panes tienen?')).toEqual(['Pan francés (canilla)'])
  })

  it('a sentence of filler words finds nothing, not every description with «con»', async () => {
    expect(await searchInventory(t.db, a.tenantId, '¿Hay algo con para hoy?', null)).toMatchObject({ products: [] })
  })
})

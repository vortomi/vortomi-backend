// Migrations 0015-0016: the categories companies typed as text on each product become
// rows of their own list, one per name ignoring case and spaces, never shared between companies.
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let client: PGlite

/** Applies drizzle/ files in order, from the first up to (not including) the one starting with `stopAt`. */
async function applyMigrations(from: string, stopAt: string | null): Promise<void> {
  const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()
  for (const file of files.filter((f) => f >= from && (stopAt === null || f < stopAt))) {
    for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement)
    }
  }
}

async function tenant(name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into tenants (name, slug, status, plan, legal_name, tax_id, fiscal_address)
     values ($1, $2, 'active', 'team', $1, 'J-41234567-8', 'Caracas') returning id`,
    [name, name.toLowerCase()],
  )
  return rows[0]!.id
}

const product = (tenantId: string, name: string, category: string) =>
  client.query(`insert into products (tenant_id, name, category, stock_mode) values ($1, $2, $3, 'units')`, [tenantId, name, category])

beforeAll(async () => {
  client = new PGlite()
  // The database as it was before categories became a list.
  await applyMigrations('0000', '0015')
})

afterAll(async () => {
  await client.close()
})

describe('free-text categories become a list', () => {
  it('one row per company and name; products point at it; the text column is gone', async () => {
    const shop = await tenant('Repuestos')
    const other = await tenant('Muebles')
    await product(shop, 'Pastillas Bosch', 'Frenos')
    await product(shop, 'Pastillas Brembo', ' frenos ')
    await product(shop, 'Amortiguador', 'Suspensión')
    await product(shop, 'Sin clasificar', '')
    await product(other, 'Silla', 'Frenos')

    await applyMigrations('0015', null)

    const categories = await client.query<{ tenant_id: string; name: string }>('select tenant_id, name from product_categories order by name')
    expect(categories.rows.filter((c) => c.tenant_id === shop).map((c) => c.name)).toEqual(['Frenos', 'Suspensión'])
    expect(categories.rows.filter((c) => c.tenant_id === other).map((c) => c.name)).toEqual(['Frenos'])

    const linked = await client.query<{ name: string; category: string | null; same_company: boolean }>(
      `select p.name, c.name as category, c.tenant_id = p.tenant_id as same_company
         from products p left join product_categories c on c.id = p.category_id order by p.name`,
    )
    expect(linked.rows).toEqual([
      { name: 'Amortiguador', category: 'Suspensión', same_company: true },
      { name: 'Pastillas Bosch', category: 'Frenos', same_company: true },
      { name: 'Pastillas Brembo', category: 'Frenos', same_company: true },
      { name: 'Silla', category: 'Frenos', same_company: true },
      { name: 'Sin clasificar', category: null, same_company: null },
    ])

    const column = await client.query(`select 1 from information_schema.columns where table_name = 'products' and column_name = 'category'`)
    expect(column.rows).toHaveLength(0)
  })
})

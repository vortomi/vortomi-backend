import { and, asc, count, eq } from 'drizzle-orm'
import { z } from 'zod'
import { productCategories, products } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

export class CategoryNotFoundError extends Error {
  constructor() {
    super('Product category not found in this company')
    this.name = 'CategoryNotFoundError'
  }
}

export const categoryInput = z.object({ name: z.string().trim().min(1).max(60) })
export type CategoryInput = z.infer<typeof categoryInput>

const columns = { id: productCategories.id, name: productCategories.name }

/**
 * The company's product categories. Everyone reads them; the routes let only admins change
 * them. A duplicate name or deleting one that still has products is refused by the database.
 */
export class CategoryService {
  /** Each category with how many products use it, so the screen can say why one cannot be deleted. */
  async list(scope: MemberScope) {
    const [rows, usage] = await Promise.all([
      scope.tx.select(columns).from(productCategories).where(eq(productCategories.tenantId, scope.tenantId)).orderBy(asc(productCategories.name)),
      scope.tx
        .select({ categoryId: products.categoryId, total: count() })
        .from(products)
        .where(eq(products.tenantId, scope.tenantId))
        .groupBy(products.categoryId),
    ])
    const totals = new Map(usage.map((u) => [u.categoryId, u.total]))
    return rows.map((row) => ({ ...row, productCount: totals.get(row.id) ?? 0 }))
  }

  async create(scope: MemberScope, input: CategoryInput) {
    const [row] = await scope.tx.insert(productCategories).values({ tenantId: scope.tenantId, name: input.name }).returning(columns)
    return { ...row!, productCount: 0 }
  }

  async update(scope: MemberScope, id: string, input: CategoryInput) {
    const [row] = await scope.tx
      .update(productCategories)
      .set(input)
      .where(and(eq(productCategories.tenantId, scope.tenantId), eq(productCategories.id, id)))
      .returning(columns)
    if (!row) throw new CategoryNotFoundError()
    return row
  }

  /** Fails on products_category_fk (409 category_in_use) while a product still uses it. */
  async remove(scope: MemberScope, id: string) {
    const deleted = await scope.tx
      .delete(productCategories)
      .where(and(eq(productCategories.tenantId, scope.tenantId), eq(productCategories.id, id)))
      .returning({ id: productCategories.id })
    if (!deleted.length) throw new CategoryNotFoundError()
  }

  /** A product may only point at a category of its own company. */
  async assertExists(scope: MemberScope, id: string | null): Promise<void> {
    if (id === null) return
    const [row] = await scope.tx
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, scope.tenantId), eq(productCategories.id, id)))
    if (!row) throw new CategoryNotFoundError()
  }
}

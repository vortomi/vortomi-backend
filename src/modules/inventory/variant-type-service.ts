import { and, asc, count, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { productVariants, variantOptions, variantTypes } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

export class VariantTypeNotFoundError extends Error {
  constructor() {
    super('Variant type not found in this company')
    this.name = 'VariantTypeNotFoundError'
  }
}

export class VariantOptionNotFoundError extends Error {
  constructor() {
    super('Variant option not found in this company')
    this.name = 'VariantOptionNotFoundError'
  }
}

export const variantTypeInput = z.object({ name: z.string().trim().min(1).max(40) })
export const variantOptionInput = z.object({ value: z.string().trim().min(1).max(60) })

/**
 * The company's variant types (Marca, Talla...) and their values (Bosch, M...). Everyone reads
 * them; the routes let only admins change them. Duplicates and deleting what variants still
 * use are refused by the database (domain-errors maps the constraints).
 */
export class VariantTypeService {
  /** Each type with its values, and how many variants use each value. */
  async list(scope: MemberScope) {
    const { tx, tenantId } = scope
    const [types, options, usage] = await Promise.all([
      tx.select({ id: variantTypes.id, name: variantTypes.name }).from(variantTypes).where(eq(variantTypes.tenantId, tenantId)).orderBy(asc(variantTypes.name)),
      tx
        .select({ id: variantOptions.id, typeId: variantOptions.typeId, value: variantOptions.value })
        .from(variantOptions)
        .where(eq(variantOptions.tenantId, tenantId))
        .orderBy(asc(variantOptions.value)),
      tx
        .select({ optionId: productVariants.optionId, total: count() })
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), isNotNull(productVariants.optionId)))
        .groupBy(productVariants.optionId),
    ])
    const totals = new Map(usage.map((u) => [u.optionId, u.total]))
    return types.map((type) => ({
      ...type,
      options: options.filter((o) => o.typeId === type.id).map(({ id, value }) => ({ id, value, variantCount: totals.get(id) ?? 0 })),
    }))
  }

  async createType(scope: MemberScope, name: string) {
    const [row] = await scope.tx.insert(variantTypes).values({ tenantId: scope.tenantId, name }).returning({ id: variantTypes.id, name: variantTypes.name })
    return { ...row!, options: [] }
  }

  async renameType(scope: MemberScope, id: string, name: string) {
    const [row] = await scope.tx
      .update(variantTypes)
      .set({ name })
      .where(and(eq(variantTypes.tenantId, scope.tenantId), eq(variantTypes.id, id)))
      .returning({ id: variantTypes.id, name: variantTypes.name })
    if (!row) throw new VariantTypeNotFoundError()
    return row
  }

  /** Takes its values along; fails while a product or a variant still uses it. */
  async removeType(scope: MemberScope, id: string) {
    const deleted = await scope.tx
      .delete(variantTypes)
      .where(and(eq(variantTypes.tenantId, scope.tenantId), eq(variantTypes.id, id)))
      .returning({ id: variantTypes.id })
    if (!deleted.length) throw new VariantTypeNotFoundError()
  }

  async addOption(scope: MemberScope, typeId: string, value: string) {
    await this.assertType(scope, typeId)
    const [row] = await scope.tx
      .insert(variantOptions)
      .values({ tenantId: scope.tenantId, typeId, value })
      .returning({ id: variantOptions.id, value: variantOptions.value })
    return { ...row!, variantCount: 0 }
  }

  /** The variants that use the value are renamed with it, in the same transaction. */
  async renameOption(scope: MemberScope, id: string, value: string) {
    const { tx, tenantId } = scope
    const [row] = await tx
      .update(variantOptions)
      .set({ value })
      .where(and(eq(variantOptions.tenantId, tenantId), eq(variantOptions.id, id)))
      .returning({ id: variantOptions.id, value: variantOptions.value })
    if (!row) throw new VariantOptionNotFoundError()
    await tx.update(productVariants).set({ name: value }).where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.optionId, id)))
    return row
  }

  /** Fails while a variant still uses it (product_variants_option_fk). */
  async removeOption(scope: MemberScope, id: string) {
    const deleted = await scope.tx
      .delete(variantOptions)
      .where(and(eq(variantOptions.tenantId, scope.tenantId), eq(variantOptions.id, id)))
      .returning({ id: variantOptions.id })
    if (!deleted.length) throw new VariantOptionNotFoundError()
  }

  async assertType(scope: MemberScope, id: string | null): Promise<void> {
    if (id === null) return
    const [row] = await scope.tx
      .select({ id: variantTypes.id })
      .from(variantTypes)
      .where(and(eq(variantTypes.tenantId, scope.tenantId), eq(variantTypes.id, id)))
    if (!row) throw new VariantTypeNotFoundError()
  }

  /** The value of an option of that type, or an error when it is not one of its values. */
  async optionValue(scope: MemberScope, typeId: string, optionId: string): Promise<string> {
    const [row] = await scope.tx
      .select({ value: variantOptions.value })
      .from(variantOptions)
      .where(and(eq(variantOptions.tenantId, scope.tenantId), eq(variantOptions.typeId, typeId), eq(variantOptions.id, optionId)))
    if (!row) throw new VariantOptionNotFoundError()
    return row.value
  }
}

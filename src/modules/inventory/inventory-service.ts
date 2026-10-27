import { and, asc, desc, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { DECIMAL_SALE_UNITS, SALE_UNITS, STOCK_MODES, STOCK_MOVEMENT_KINDS, type SaleUnit, type StockMovementKind } from '../../db/schema/enums.ts'
import { productCategories, productVariants, products, stockMovements } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { CategoryService } from './category-service.ts'
import type { VariantTypeService } from './variant-type-service.ts'

export class InventoryNotFoundError extends Error {
  constructor() {
    super('Product or variant not found in this company')
    this.name = 'InventoryNotFoundError'
  }
}

export class MovementNotAllowedError extends Error {
  constructor() {
    super('Only admins record purchases, adjustments and losses')
    this.name = 'MovementNotAllowedError'
  }
}

/** A variant that does not fit its product's types: a value missing, or one where none is used. */
export class InvalidVariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidVariantError'
  }
}

/** The product's types cannot change while its variants use their values. */
export class VariantTypesLockedError extends Error {
  constructor() {
    super('The product variant types are in use by its variants')
    this.name = 'VariantTypesLockedError'
  }
}

/** A quantity that does not fit the product's unit: fractions of something that counts whole. */
export class InvalidQuantityError extends Error {
  constructor() {
    super('This product counts whole units: no fractions')
    this.name = 'InvalidQuantityError'
  }
}

/** Switching to a unit that counts whole while some stock is a fraction (12,5 m to "Rollo"). */
export class FractionalStockError extends Error {
  constructor() {
    super('Some variant has a fractional count: adjust it before selling by a whole unit')
    this.name = 'FractionalStockError'
  }
}

/** The choices the panel offers for "Venta mínima" and "De cuánto en cuánto" (closed lists). */
export const MIN_QUANTITIES = [0.1, 0.25, 0.5, 1, 2, 3, 5, 6, 10, 12] as const
export const QUANTITY_STEPS = [0.1, 0.25, 0.5, 1] as const

const MAX_TYPES = 3
const money = z.number().int().min(0).max(2_000_000_000)
// Up to 3 decimals; whether fractions are allowed depends on the product's unit (fitsUnit).
const amount = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .refine((value) => hasAtMostThreeDecimals(value), 'at most 3 decimals')

function hasAtMostThreeDecimals(value: number): boolean {
  return Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6
}

export function takesDecimals(unit: SaleUnit): boolean {
  return DECIMAL_SALE_UNITS.includes(unit)
}

/** A quantity in the product's unit: whole for pieces, up to 3 decimals for kilos, metres... */
function fitsUnit(value: number, unit: SaleUnit): boolean {
  return takesDecimals(unit) ? hasAtMostThreeDecimals(value) : Number.isInteger(value)
}

export const variantInput = z.object({
  // One value per type of the product, in its order; the name comes from them ("M / Rojo").
  // Without types the name is typed ("Única").
  optionIds: z.array(z.uuid()).max(MAX_TYPES).default([]),
  name: z.string().trim().max(80).default(''),
  sku: z.string().trim().min(1).max(60),
  priceCents: money,
  available: z.boolean().default(true),
  lowStockThreshold: amount.default(0),
  // Units mode: the opening count becomes an 'initial' movement, never a direct write.
  initialStock: amount.default(0),
})

const productFields = z.object({
  name: z.string().trim().min(1).max(120),
  // One of the company's categories (category-service); null while it has none.
  categoryId: z.uuid().nullable().default(null),
  // Up to three of the company's variant types, in order; none: variants named freely.
  variantTypeIds: z
    .array(z.uuid())
    .max(MAX_TYPES)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'each type once'),
  description: z.string().trim().max(2000).default(''),
  stockMode: z.enum(STOCK_MODES),
  saleUnit: z.enum(SALE_UNITS).default('unit'),
  minQuantity: z
    .number()
    .refine((value) => (MIN_QUANTITIES as readonly number[]).includes(value), 'one of the offered minimums')
    .default(1),
  quantityStep: z
    .number()
    .refine((value) => (QUANTITY_STEPS as readonly number[]).includes(value), 'one of the offered steps')
    .default(1),
  variants: z.array(variantInput).min(1).max(100),
})

type SaleFields = Pick<z.infer<typeof productFields>, 'saleUnit' | 'minQuantity' | 'quantityStep'>

/** Whole units sell one at a time from a whole minimum; the rest from a minimum that is a whole number of steps. */
function checkSaleQuantities({ saleUnit, minQuantity, quantityStep }: SaleFields, ctx: z.RefinementCtx): void {
  const fits = takesDecimals(saleUnit)
    ? Math.abs(minQuantity / quantityStep - Math.round(minQuantity / quantityStep)) < 1e-9
    : quantityStep === 1 && Number.isInteger(minQuantity)
  if (!fits) ctx.addIssue({ code: 'custom', message: 'The minimum and the step do not fit the sale unit', path: ['minQuantity'] })
}

export const productInput = productFields.superRefine(checkSaleQuantities)
export type ProductInput = z.infer<typeof productInput>
type VariantInput = z.infer<typeof variantInput>

/** What can change once a product exists. The stock mode cannot: its history is counted one way. */
export const productUpdate = productFields
  .pick({ name: true, categoryId: true, variantTypeIds: true, description: true, saleUnit: true, minQuantity: true, quantityStep: true })
  .superRefine(checkSaleQuantities)
export type ProductUpdate = z.infer<typeof productUpdate>

export const variantUpdate = variantInput.omit({ initialStock: true })
export type VariantUpdate = z.infer<typeof variantUpdate>

export const movementInput = z.object({
  kind: z.enum(STOCK_MOVEMENT_KINDS).exclude(['initial']),
  // Positive adds, negative removes; the database checks the sign against the kind.
  quantity: z
    .number()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((value) => value !== 0 && hasAtMostThreeDecimals(value)),
  reason: z.string().trim().max(200).default(''),
})
export type MovementInput = z.infer<typeof movementInput>

interface ProductShape {
  stockMode: ProductInput['stockMode']
  saleUnit: SaleUnit
  typeIds: string[]
}

/** Selling and taking back what was sold is everyday work; the rest changes the books. */
const AGENT_MOVEMENTS: readonly StockMovementKind[] = ['sale', 'return']

const variantColumns = {
  id: productVariants.id,
  productId: productVariants.productId,
  optionIds: sql<string[]>`array_remove(array[${productVariants.optionId}, ${productVariants.option2Id}, ${productVariants.option3Id}], null)`,
  name: productVariants.name,
  sku: productVariants.sku,
  priceCents: productVariants.priceCents,
  onHand: productVariants.onHand,
  reserved: productVariants.reserved,
  // What can be promised to a customer right now.
  availableUnits: sql<number>`${productVariants.onHand} - ${productVariants.reserved}`.mapWith(Number),
  available: productVariants.available,
  lowStockThreshold: productVariants.lowStockThreshold,
}

const typeIdsOf = (row: { variantTypeId: string | null; variantType2Id: string | null; variantType3Id: string | null }) =>
  [row.variantTypeId, row.variantType2Id, row.variantType3Id].filter((id): id is string => id !== null)

/** The product's types as its three columns, in order. */
const typeColumns = (typeIds: readonly string[]) => ({
  variantTypeId: typeIds[0] ?? null,
  variantType2Id: typeIds[1] ?? null,
  variantType3Id: typeIds[2] ?? null,
})

export class InventoryService {
  constructor(
    private readonly categories: CategoryService,
    private readonly variantTypes: VariantTypeService,
  ) {}

  async list(scope: MemberScope) {
    const [items, variants] = await Promise.all([
      scope.tx
        .select({
          id: products.id,
          name: products.name,
          categoryId: products.categoryId,
          variantTypeIds: sql<string[]>`array_remove(array[${products.variantTypeId}, ${products.variantType2Id}, ${products.variantType3Id}], null)`,
          // The name too, so screens and exports need no second lookup.
          category: sql<string>`coalesce(${productCategories.name}, '')`,
          description: products.description,
          stockMode: products.stockMode,
          saleUnit: products.saleUnit,
          minQuantity: products.minQuantity,
          quantityStep: products.quantityStep,
          active: products.active,
          createdAt: products.createdAt,
        })
        .from(products)
        .leftJoin(productCategories, and(eq(productCategories.tenantId, products.tenantId), eq(productCategories.id, products.categoryId)))
        .where(eq(products.tenantId, scope.tenantId))
        .orderBy(asc(products.name)),
      scope.tx.select(variantColumns).from(productVariants).where(eq(productVariants.tenantId, scope.tenantId)).orderBy(asc(productVariants.name)),
    ])
    return items.map((product) => ({ ...product, variants: variants.filter((variant) => variant.productId === product.id) }))
  }

  /** One transaction: the product, its variants and their opening stock as movements. */
  async create(scope: MemberScope, input: ProductInput) {
    const { tx, tenantId } = scope
    await this.categories.assertExists(scope, input.categoryId)
    for (const typeId of input.variantTypeIds) await this.variantTypes.assertType(scope, typeId)
    const { variants, variantTypeIds, ...fields } = input
    const [product] = await tx
      .insert(products)
      .values({ tenantId, ...fields, ...typeColumns(variantTypeIds) })
      .returning({ id: products.id })
    const shape = { stockMode: input.stockMode, saleUnit: input.saleUnit, typeIds: variantTypeIds }
    for (const variant of variants) await this.insertVariant(scope, product!.id, shape, variant)
    return product!
  }

  /**
   * Name, category, description and how it is sold. The types change only while no variant uses
   * their values; a unit that counts whole is refused while some count is a fraction.
   */
  async updateProduct(scope: MemberScope, productId: string, { variantTypeIds, ...input }: ProductUpdate) {
    const { tx, tenantId } = scope
    await this.categories.assertExists(scope, input.categoryId)
    for (const typeId of variantTypeIds) await this.variantTypes.assertType(scope, typeId)
    const current = await this.productShape(scope, productId)
    const ofProduct = and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId))
    if (current.typeIds.join() !== variantTypeIds.join()) {
      const [used] = await tx.select({ id: productVariants.id }).from(productVariants).where(and(ofProduct, isNotNull(productVariants.optionId))).limit(1)
      if (used) throw new VariantTypesLockedError()
    }
    if (!takesDecimals(input.saleUnit)) {
      const fraction = (column: AnyPgColumn) => sql`${column} <> trunc(${column})`
      const [fractional] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(ofProduct, or(fraction(productVariants.onHand), fraction(productVariants.reserved), fraction(productVariants.lowStockThreshold))))
        .limit(1)
      if (fractional) throw new FractionalStockError()
    }
    await tx
      .update(products)
      .set({ ...input, ...typeColumns(variantTypeIds) })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
  }

  /** A new variant of an existing product, with its opening stock as a movement like at creation. */
  async addVariant(scope: MemberScope, productId: string, input: VariantInput) {
    return { id: await this.insertVariant(scope, productId, await this.productShape(scope, productId), input) }
  }

  private async insertVariant(scope: MemberScope, productId: string, product: ProductShape, { initialStock, ...variant }: VariantInput) {
    const { tx, tenantId } = scope
    if (!fitsUnit(initialStock, product.saleUnit) || !fitsUnit(variant.lowStockThreshold, product.saleUnit)) throw new InvalidQuantityError()
    const naming = await this.naming(scope, product.typeIds, variant)
    const { optionIds: _optionIds, ...fields } = variant
    const [row] = await tx.insert(productVariants).values({ tenantId, productId, ...fields, ...naming }).returning({ id: productVariants.id })
    if (product.stockMode === 'units' && initialStock > 0) {
      await tx.insert(stockMovements).values({ tenantId, variantId: row!.id, kind: 'initial', quantity: initialStock, reason: 'Existencia inicial', userId: scope.member.userId })
    }
    return row!.id
  }

  async updateVariant(scope: MemberScope, variantId: string, input: VariantUpdate) {
    const [current] = await scope.tx
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
    if (!current) throw new InventoryNotFoundError()
    const product = await this.productShape(scope, current.productId)
    if (!fitsUnit(input.lowStockThreshold, product.saleUnit)) throw new InvalidQuantityError()
    const naming = await this.naming(scope, product.typeIds, input)
    const { optionIds: _optionIds, ...fields } = input
    const [row] = await scope.tx
      .update(productVariants)
      .set({ ...fields, ...naming })
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
      .returning(variantColumns)
    if (!row) throw new InventoryNotFoundError()
    return row
  }

  private async productShape(scope: MemberScope, productId: string): Promise<ProductShape> {
    const [product] = await scope.tx
      .select({
        stockMode: products.stockMode,
        saleUnit: products.saleUnit,
        variantTypeId: products.variantTypeId,
        variantType2Id: products.variantType2Id,
        variantType3Id: products.variantType3Id,
      })
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.id, productId)))
    if (!product) throw new InventoryNotFoundError()
    return { stockMode: product.stockMode, saleUnit: product.saleUnit, typeIds: typeIdsOf(product) }
  }

  /**
   * How a variant is named under its product's types: one value of each, in order (the name is
   * "M / Rojo"), or, without types, the name typed. Variants from before the product had types
   * keep their typed name.
   */
  private async naming(scope: MemberScope, typeIds: readonly string[], variant: Pick<VariantInput, 'optionIds' | 'name'>) {
    const { optionIds } = variant
    if (optionIds.length) {
      if (!typeIds.length) throw new InvalidVariantError('This product has no variant types: name its variants instead')
      if (optionIds.length !== typeIds.length) throw new InvalidVariantError('Choose one value of each of the product types')
      const values: string[] = []
      for (const [index, optionId] of optionIds.entries()) values.push(await this.variantTypes.optionValue(scope, typeIds[index]!, optionId))
      return {
        ...typeColumns(typeIds),
        optionId: optionIds[0]!,
        option2Id: optionIds[1] ?? null,
        option3Id: optionIds[2] ?? null,
        name: values.join(' / '),
      }
    }
    if (!variant.name) throw new InvalidVariantError(typeIds.length ? 'Choose the values of the product types' : 'Name the variant')
    return { ...typeColumns([]), optionId: null, option2Id: null, option3Id: null, name: variant.name }
  }

  async setActive(scope: MemberScope, productId: string, active: boolean) {
    const updated = await scope.tx
      .update(products)
      .set({ active })
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.id, productId)))
      .returning({ id: products.id })
    if (!updated.length) throw new InventoryNotFoundError()
  }

  /**
   * Records a movement; the trigger moves the count in the same statement. Selling more
   * than is available fails on product_variants_stock_check (409 insufficient_stock).
   */
  async move(scope: MemberScope, variantId: string, input: MovementInput) {
    if (scope.member.role !== 'admin' && !AGENT_MOVEMENTS.includes(input.kind)) throw new MovementNotAllowedError()
    const [variant] = await scope.tx
      .select({ id: productVariants.id, saleUnit: products.saleUnit })
      .from(productVariants)
      .innerJoin(products, and(eq(products.tenantId, productVariants.tenantId), eq(products.id, productVariants.productId)))
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
    if (!variant) throw new InventoryNotFoundError()
    if (!fitsUnit(input.quantity, variant.saleUnit)) throw new InvalidQuantityError()
    await scope.tx.insert(stockMovements).values({ tenantId: scope.tenantId, variantId, ...input, userId: scope.member.userId })
    const [row] = await scope.tx.select(variantColumns).from(productVariants).where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
    return row!
  }

  history(scope: MemberScope, variantId: string) {
    return scope.tx
      .select({ id: stockMovements.id, kind: stockMovements.kind, quantity: stockMovements.quantity, reason: stockMovements.reason, userId: stockMovements.userId, createdAt: stockMovements.createdAt })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, scope.tenantId), eq(stockMovements.variantId, variantId)))
      .orderBy(desc(stockMovements.id))
      .limit(200)
  }
}

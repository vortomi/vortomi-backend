import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { STOCK_MODES, STOCK_MOVEMENT_KINDS, type StockMovementKind } from '../../db/schema/enums.ts'
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

/** A variant that does not fit its product's type: an option missing, or one where none is used. */
export class InvalidVariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidVariantError'
  }
}

const money = z.number().int().min(0).max(2_000_000_000)

export const variantInput = z.object({
  // With a variant type the name comes from the option; without one it is typed ("Única").
  optionId: z.uuid().nullable().default(null),
  name: z.string().trim().max(80).default(''),
  sku: z.string().trim().min(1).max(60),
  priceCents: money,
  available: z.boolean().default(true),
  lowStockThreshold: z.number().int().min(0).max(1_000_000).default(0),
  // Units mode: the opening count becomes an 'initial' movement, never a direct write.
  initialStock: z.number().int().min(0).max(1_000_000).default(0),
})

export const productInput = z.object({
  name: z.string().trim().min(1).max(120),
  // One of the company's categories (category-service); null while it has none.
  categoryId: z.uuid().nullable().default(null),
  // One of the company's variant types (variant-type-service); null: variants named freely.
  variantTypeId: z.uuid().nullable().default(null),
  description: z.string().trim().max(2000).default(''),
  stockMode: z.enum(STOCK_MODES),
  variants: z.array(variantInput).min(1).max(50),
})
export type ProductInput = z.infer<typeof productInput>
type VariantInput = z.infer<typeof variantInput>

/** What can change once a product exists. The stock mode cannot: its history is counted one way. */
/** The type can change only while no variant uses one of its values (product_variants_product_type_fk). */
export const productUpdate = productInput.pick({ name: true, categoryId: true, variantTypeId: true, description: true })
export type ProductUpdate = z.infer<typeof productUpdate>

export const variantUpdate = variantInput.omit({ initialStock: true })
export type VariantUpdate = z.infer<typeof variantUpdate>

export const movementInput = z.object({
  kind: z.enum(STOCK_MOVEMENT_KINDS).exclude(['initial']),
  // Positive adds, negative removes; the database checks the sign against the kind.
  quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0),
  reason: z.string().trim().max(200).default(''),
})
export type MovementInput = z.infer<typeof movementInput>

type ProductShape = Pick<ProductInput, 'stockMode' | 'variantTypeId'>

/** Selling and taking back what was sold is everyday work; the rest changes the books. */
const AGENT_MOVEMENTS: readonly StockMovementKind[] = ['sale', 'return']

const variantColumns = {
  id: productVariants.id,
  productId: productVariants.productId,
  optionId: productVariants.optionId,
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
          variantTypeId: products.variantTypeId,
          // The name too, so screens and exports need no second lookup.
          category: sql<string>`coalesce(${productCategories.name}, '')`,
          description: products.description,
          stockMode: products.stockMode,
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
    await this.variantTypes.assertType(scope, input.variantTypeId)
    const { variants, ...fields } = input
    const [product] = await tx.insert(products).values({ tenantId, ...fields }).returning({ id: products.id })
    for (const variant of variants) await this.insertVariant(scope, product!.id, input, variant)
    return product!
  }

  async updateProduct(scope: MemberScope, productId: string, input: ProductUpdate) {
    await this.categories.assertExists(scope, input.categoryId)
    await this.variantTypes.assertType(scope, input.variantTypeId)
    const updated = await scope.tx
      .update(products)
      .set(input)
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.id, productId)))
      .returning({ id: products.id })
    if (!updated.length) throw new InventoryNotFoundError()
  }

  /** A new variant of an existing product, with its opening stock as a movement like at creation. */
  async addVariant(scope: MemberScope, productId: string, input: VariantInput) {
    return { id: await this.insertVariant(scope, productId, await this.productShape(scope, productId), input) }
  }

  private async insertVariant(scope: MemberScope, productId: string, product: ProductShape, { initialStock, ...variant }: VariantInput) {
    const { tx, tenantId } = scope
    const naming = await this.naming(scope, product.variantTypeId, variant)
    const [row] = await tx.insert(productVariants).values({ tenantId, productId, ...variant, ...naming }).returning({ id: productVariants.id })
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
    const naming = await this.naming(scope, (await this.productShape(scope, current.productId)).variantTypeId, input)
    const [row] = await scope.tx
      .update(productVariants)
      .set({ ...input, ...naming })
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
      .returning(variantColumns)
    if (!row) throw new InventoryNotFoundError()
    return row
  }

  private async productShape(scope: MemberScope, productId: string): Promise<ProductShape> {
    const [product] = await scope.tx
      .select({ stockMode: products.stockMode, variantTypeId: products.variantTypeId })
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.id, productId)))
    if (!product) throw new InventoryNotFoundError()
    return product
  }

  /**
   * How a variant is named under its product's type: a value of that type (the name is the
   * value), or, without a type, the name typed. Variants from before the product had a type
   * keep their typed name.
   */
  private async naming(scope: MemberScope, typeId: string | null, variant: Pick<VariantInput, 'optionId' | 'name'>) {
    if (variant.optionId) {
      if (!typeId) throw new InvalidVariantError('This product has no variant type: name its variants instead')
      return { variantTypeId: typeId, optionId: variant.optionId, name: await this.variantTypes.optionValue(scope, typeId, variant.optionId) }
    }
    if (!variant.name) throw new InvalidVariantError(typeId ? 'Choose one of the values of the product type' : 'Name the variant')
    return { variantTypeId: null, optionId: null, name: variant.name }
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
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
    if (!variant) throw new InventoryNotFoundError()
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

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { STOCK_MODES, STOCK_MOVEMENT_KINDS, type StockMovementKind } from '../../db/schema/enums.ts'
import { productVariants, products, stockMovements } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

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

const money = z.number().int().min(0).max(2_000_000_000)

const variantInput = z.object({
  name: z.string().trim().min(1).max(80),
  sku: z.string().trim().min(1).max(60),
  priceCents: money,
  available: z.boolean().default(true),
  lowStockThreshold: z.number().int().min(0).max(1_000_000).default(0),
  // Units mode: the opening count becomes an 'initial' movement, never a direct write.
  initialStock: z.number().int().min(0).max(1_000_000).default(0),
})

export const productInput = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).default(''),
  description: z.string().trim().max(2000).default(''),
  stockMode: z.enum(STOCK_MODES),
  variants: z.array(variantInput).min(1).max(50),
})
export type ProductInput = z.infer<typeof productInput>

export const variantUpdate = variantInput.omit({ initialStock: true })
export type VariantUpdate = z.infer<typeof variantUpdate>

export const movementInput = z.object({
  kind: z.enum(STOCK_MOVEMENT_KINDS).exclude(['initial']),
  // Positive adds, negative removes; the database checks the sign against the kind.
  quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0),
  reason: z.string().trim().max(200).default(''),
})
export type MovementInput = z.infer<typeof movementInput>

/** Selling and taking back what was sold is everyday work; the rest changes the books. */
const AGENT_MOVEMENTS: readonly StockMovementKind[] = ['sale', 'return']

const variantColumns = {
  id: productVariants.id,
  productId: productVariants.productId,
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
  async list(scope: MemberScope) {
    const [items, variants] = await Promise.all([
      scope.tx
        .select({ id: products.id, name: products.name, category: products.category, description: products.description, stockMode: products.stockMode, active: products.active })
        .from(products)
        .where(eq(products.tenantId, scope.tenantId))
        .orderBy(asc(products.name)),
      scope.tx.select(variantColumns).from(productVariants).where(eq(productVariants.tenantId, scope.tenantId)).orderBy(asc(productVariants.name)),
    ])
    return items.map((product) => ({ ...product, variants: variants.filter((variant) => variant.productId === product.id) }))
  }

  /** One transaction: the product, its variants and their opening stock as movements. */
  async create(scope: MemberScope, input: ProductInput) {
    const { tx, tenantId } = scope
    const [product] = await tx
      .insert(products)
      .values({ tenantId, name: input.name, category: input.category, description: input.description, stockMode: input.stockMode })
      .returning({ id: products.id })
    for (const { initialStock, ...variant } of input.variants) {
      const [row] = await tx.insert(productVariants).values({ tenantId, productId: product!.id, ...variant }).returning({ id: productVariants.id })
      if (input.stockMode === 'units' && initialStock > 0) {
        await tx.insert(stockMovements).values({ tenantId, variantId: row!.id, kind: 'initial', quantity: initialStock, reason: 'Existencia inicial', userId: scope.member.userId })
      }
    }
    return product!
  }

  async updateVariant(scope: MemberScope, variantId: string, input: VariantUpdate) {
    const [row] = await scope.tx
      .update(productVariants)
      .set(input)
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.id, variantId)))
      .returning(variantColumns)
    if (!row) throw new InventoryNotFoundError()
    return row
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

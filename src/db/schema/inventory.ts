import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { memberships } from './access.ts'
import { createdAtColumn, oneOf, serialIdColumn, tenantIdColumn, uuidIdColumn } from './columns.ts'
import { STOCK_MODES, STOCK_MOVEMENT_KINDS } from './enums.ts'
import { tenants } from './tenancy.ts'

// Inventory (documentations/05): stock is a history of immutable movements; the
// current count on each variant is kept by a trigger (drizzle/0013_inventory_security.sql).

/** The company's own list of categories; a product picks one instead of typing it. */
export const productCategories = pgTable(
  'product_categories',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    name: text('name').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('product_categories_tenant_id_id_key').on(t.tenantId, t.id),
    // "Frenos" and "frenos" are the same category.
    uniqueIndex('product_categories_tenant_name_key').on(t.tenantId, sql`lower(${t.name})`),
    check('product_categories_name_check', sql`length(trim(${t.name})) between 1 and 60`),
  ],
)

export const products = pgTable(
  'products',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    name: text('name').notNull(),
    // Null: no category yet. A category with products cannot be deleted (products_category_fk).
    categoryId: uuid('category_id'),
    description: text('description').notNull().default(''),
    stockMode: text('stock_mode', { enum: STOCK_MODES }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('products_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({ name: 'products_category_fk', columns: [t.tenantId, t.categoryId], foreignColumns: [productCategories.tenantId, productCategories.id] }),
    index('products_category_idx').on(t.tenantId, t.categoryId),
    check('products_stock_mode_check', oneOf(t.stockMode, STOCK_MODES)),
    check('products_name_check', sql`length(trim(${t.name})) between 1 and 120`),
  ],
)

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    productId: uuid('product_id').notNull(),
    // What tells variants apart: brand, model, size...
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    // Dollars, in cents.
    priceCents: integer('price_cents').notNull(),
    // Units mode. Only stock movements change them (trigger); the API cannot write them.
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    // Availability mode switch.
    available: boolean('available').notNull().default(true),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('product_variants_tenant_id_id_key').on(t.tenantId, t.id),
    // The SKU is unique per company, not globally.
    uniqueIndex('product_variants_tenant_sku_key').on(t.tenantId, sql`lower(${t.sku})`),
    foreignKey({ name: 'product_variants_product_fk', columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }),
    index('product_variants_product_idx').on(t.tenantId, t.productId),
    check('product_variants_price_check', sql`${t.priceCents} >= 0`),
    // Never fewer units than are set aside: this is what refuses selling the last unit twice.
    check('product_variants_stock_check', sql`${t.reserved} >= 0 and ${t.onHand} >= ${t.reserved}`),
    check('product_variants_threshold_check', sql`${t.lowStockThreshold} >= 0`),
    check('product_variants_sku_check', sql`length(trim(${t.sku})) between 1 and 60`),
  ],
)

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: serialIdColumn(),
    tenantId: tenantIdColumn(),
    variantId: uuid('variant_id').notNull(),
    kind: text('kind', { enum: STOCK_MOVEMENT_KINDS }).notNull(),
    // Positive adds, negative removes.
    quantity: integer('quantity').notNull(),
    reason: text('reason').notNull().default(''),
    userId: uuid('user_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({ name: 'stock_movements_variant_fk', columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ name: 'stock_movements_user_fk', columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index('stock_movements_variant_created_idx').on(t.tenantId, t.variantId, t.createdAt),
    check('stock_movements_kind_check', oneOf(t.kind, STOCK_MOVEMENT_KINDS)),
    check(
      'stock_movements_sign_check',
      sql`case
        when ${t.kind} in ('initial', 'purchase', 'return') then ${t.quantity} > 0
        when ${t.kind} in ('sale', 'loss') then ${t.quantity} < 0
        else ${t.quantity} <> 0 end`,
    ),
    check('stock_movements_reason_check', sql`length(${t.reason}) <= 200`),
  ],
)

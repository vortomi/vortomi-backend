import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, numeric, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { memberships } from './access.ts'
import { createdAtColumn, oneOf, serialIdColumn, tenantIdColumn, uuidIdColumn } from './columns.ts'
import { DECIMAL_SALE_UNITS, SALE_UNITS, STOCK_MODES, STOCK_MOVEMENT_KINDS } from './enums.ts'
import { tenants } from './tenancy.ts'

// Inventory (documentations/05): stock is a history of immutable movements; the
// current count on each variant is kept by a trigger (drizzle/0013_inventory_security.sql).
// Quantities have 3 decimals: a product sold by the kilo or the metre counts fractions.

/** Units, reservations, thresholds and movements: up to 3 decimals (1 g of a kilo). */
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3, mode: 'number' })

/** The units that take decimals, as an SQL list for CHECK constraints (constants, never input). */
const decimalUnits = sql.raw(DECIMAL_SALE_UNITS.map((unit) => `'${unit}'`).join(', '))

const NO_OPTION = sql`'00000000-0000-0000-0000-000000000000'::uuid`

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

/** What tells a product's variants apart (Marca, Talla, Presentación), defined once per company. */
export const variantTypes = pgTable(
  'variant_types',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    name: text('name').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('variant_types_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('variant_types_tenant_name_key').on(t.tenantId, sql`lower(${t.name})`),
    check('variant_types_name_check', sql`length(trim(${t.name})) between 1 and 40`),
  ],
)

/** The values of a type (Bosch, Brembo...). A variant picks one instead of typing it. */
export const variantOptions = pgTable(
  'variant_options',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    typeId: uuid('type_id').notNull(),
    value: text('value').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('variant_options_tenant_id_id_key').on(t.tenantId, t.id),
    // Lets a variant require that its option belongs to the product's type (product_variants_option_fk).
    unique('variant_options_tenant_type_id_key').on(t.tenantId, t.typeId, t.id),
    uniqueIndex('variant_options_type_value_key').on(t.tenantId, t.typeId, sql`lower(${t.value})`),
    // Deleting a type takes its values along; it fails while a variant still uses one of them.
    foreignKey({ name: 'variant_options_type_fk', columns: [t.tenantId, t.typeId], foreignColumns: [variantTypes.tenantId, variantTypes.id] }).onDelete('cascade'),
    check('variant_options_value_check', sql`length(trim(${t.value})) between 1 and 60`),
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
    // Up to three variant types combined (Talla x Color x Material), in order. None: variants are
    // named freely (a single "Única", or products from before types existed).
    variantTypeId: uuid('variant_type_id'),
    variantType2Id: uuid('variant_type_2_id'),
    variantType3Id: uuid('variant_type_3_id'),
    description: text('description').notNull().default(''),
    stockMode: text('stock_mode', { enum: STOCK_MODES }).notNull(),
    // The price is per this unit and quantities count in it.
    saleUnit: text('sale_unit', { enum: SALE_UNITS }).notNull().default('unit'),
    // The least a customer can order, and the size of each step above it (0,5 m at a time).
    minQuantity: quantity('min_quantity').notNull().default(1),
    quantityStep: quantity('quantity_step').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('products_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({ name: 'products_category_fk', columns: [t.tenantId, t.categoryId], foreignColumns: [productCategories.tenantId, productCategories.id] }),
    index('products_category_idx').on(t.tenantId, t.categoryId),
    // (tenant, id, type) lets each variant check its option against the product's type.
    unique('products_tenant_id_type_key').on(t.tenantId, t.id, t.variantTypeId),
    unique('products_tenant_id_type_2_key').on(t.tenantId, t.id, t.variantType2Id),
    unique('products_tenant_id_type_3_key').on(t.tenantId, t.id, t.variantType3Id),
    foreignKey({ name: 'products_variant_type_fk', columns: [t.tenantId, t.variantTypeId], foreignColumns: [variantTypes.tenantId, variantTypes.id] }),
    foreignKey({ name: 'products_variant_type_2_fk', columns: [t.tenantId, t.variantType2Id], foreignColumns: [variantTypes.tenantId, variantTypes.id] }),
    foreignKey({ name: 'products_variant_type_3_fk', columns: [t.tenantId, t.variantType3Id], foreignColumns: [variantTypes.tenantId, variantTypes.id] }),
    // Types fill in order and never repeat.
    check(
      'products_variant_types_check',
      sql`(${t.variantType2Id} is null or (${t.variantTypeId} is not null and ${t.variantType2Id} <> ${t.variantTypeId}))
        and (${t.variantType3Id} is null or (${t.variantType2Id} is not null and ${t.variantType3Id} not in (${t.variantTypeId}, ${t.variantType2Id})))`,
    ),
    check('products_sale_unit_check', oneOf(t.saleUnit, SALE_UNITS)),
    // Units that count whole sell one at a time, from a whole minimum.
    check(
      'products_quantities_check',
      sql`${t.minQuantity} > 0 and ${t.quantityStep} > 0
        and (${t.saleUnit} in (${decimalUnits}) or (${t.quantityStep} = 1 and ${t.minQuantity} = trunc(${t.minQuantity})))`,
    ),
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
    // What tells variants apart: brand, model, size... With an option, its value (kept in sync by the API).
    name: text('name').notNull(),
    // One value per type of the product, in the product's order. Each type is repeated so the
    // database can check that the value belongs to it and that it is one of the product's types.
    variantTypeId: uuid('variant_type_id'),
    optionId: uuid('option_id'),
    variantType2Id: uuid('variant_type_2_id'),
    option2Id: uuid('option_2_id'),
    variantType3Id: uuid('variant_type_3_id'),
    option3Id: uuid('option_3_id'),
    sku: text('sku').notNull(),
    // Dollars, in cents.
    priceCents: integer('price_cents').notNull(),
    // Units mode. Only stock movements change them (trigger); the API cannot write them.
    onHand: quantity('on_hand').notNull().default(0),
    reserved: quantity('reserved').notNull().default(0),
    // Availability mode switch.
    available: boolean('available').notNull().default(true),
    lowStockThreshold: quantity('low_stock_threshold').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('product_variants_tenant_id_id_key').on(t.tenantId, t.id),
    // The SKU is unique per company, not globally.
    uniqueIndex('product_variants_tenant_sku_key').on(t.tenantId, sql`lower(${t.sku})`),
    foreignKey({ name: 'product_variants_product_fk', columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }),
    // The variant's type is the product's type: it cannot change while variants use it.
    foreignKey({
      name: 'product_variants_product_type_fk',
      columns: [t.tenantId, t.productId, t.variantTypeId],
      foreignColumns: [products.tenantId, products.id, products.variantTypeId],
    }),
    foreignKey({
      name: 'product_variants_product_type_2_fk',
      columns: [t.tenantId, t.productId, t.variantType2Id],
      foreignColumns: [products.tenantId, products.id, products.variantType2Id],
    }),
    foreignKey({
      name: 'product_variants_product_type_3_fk',
      columns: [t.tenantId, t.productId, t.variantType3Id],
      foreignColumns: [products.tenantId, products.id, products.variantType3Id],
    }),
    // Each option must be a value of its own type, of the same company.
    foreignKey({
      name: 'product_variants_option_fk',
      columns: [t.tenantId, t.variantTypeId, t.optionId],
      foreignColumns: [variantOptions.tenantId, variantOptions.typeId, variantOptions.id],
    }),
    foreignKey({
      name: 'product_variants_option_2_fk',
      columns: [t.tenantId, t.variantType2Id, t.option2Id],
      foreignColumns: [variantOptions.tenantId, variantOptions.typeId, variantOptions.id],
    }),
    foreignKey({
      name: 'product_variants_option_3_fk',
      columns: [t.tenantId, t.variantType3Id, t.option3Id],
      foreignColumns: [variantOptions.tenantId, variantOptions.typeId, variantOptions.id],
    }),
    // A product cannot have the same combination twice ("M / Rojo" and "M / Rojo").
    uniqueIndex('product_variants_product_option_key')
      .on(t.tenantId, t.productId, t.optionId, sql`coalesce(${t.option2Id}, ${NO_OPTION})`, sql`coalesce(${t.option3Id}, ${NO_OPTION})`)
      .where(sql`${t.optionId} is not null`),
    check('product_variants_option_check', sql`(${t.optionId} is null) = (${t.variantTypeId} is null)`),
    check('product_variants_option_2_check', sql`(${t.option2Id} is null) = (${t.variantType2Id} is null)`),
    check('product_variants_option_3_check', sql`(${t.option3Id} is null) = (${t.variantType3Id} is null)`),
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
    quantity: quantity('quantity').notNull(),
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

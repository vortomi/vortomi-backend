import { sql } from 'drizzle-orm'
import { check, customType, foreignKey, index, integer, numeric, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, quantityColumn, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { conversations } from './conversations.ts'
import { FULFILLMENTS, ORDER_STATUSES, SALE_UNITS } from './enums.ts'
import { paymentMethods } from './payment-methods.ts'

// Orders taken in a conversation (by the sales agent, for now). Prices are a snapshot taken when
// the order was placed, in US cents with the rate of that moment: later changes do not touch it.

export const orders = pgTable(
  'orders',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    conversationId: uuid('conversation_id').notNull(),
    // Short code people read out ("P-7K3F9Q"), unique per company.
    code: text('code').notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('awaiting_payment'),
    // What placed it, for idempotency: the customer message it answers (one order per message).
    sourceKey: text('source_key').notNull(),
    customerName: text('customer_name').notNull(),
    fulfillment: text('fulfillment', { enum: FULFILLMENTS }).notNull(),
    zone: text('zone'),
    address: text('address'),
    // The method the customer chose (Ajustes → Métodos de pago); null when the company has none.
    paymentMethodId: uuid('payment_method_id'),
    notes: text('notes').notNull().default(''),
    subtotalCents: integer('subtotal_cents').notNull(),
    // Null: delivery whose cost a person confirms (zone not priced); 0 for pickup or free delivery.
    deliveryCents: integer('delivery_cents'),
    bsPerUsd: numeric('bs_per_usd', { precision: 18, scale: 8 }),
    // The bank reference of the customer's payment, typed by whoever checks it (goes on the receipt).
    paymentReference: text('payment_reference'),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('orders_tenant_id_id_key').on(t.tenantId, t.id),
    unique('orders_tenant_code_key').on(t.tenantId, t.code),
    unique('orders_tenant_source_key').on(t.tenantId, t.sourceKey),
    foreignKey({ name: 'orders_conversation_fk', columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }),
    index('orders_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('orders_status_check', oneOf(t.status, ORDER_STATUSES)),
    check('orders_fulfillment_check', oneOf(t.fulfillment, FULFILLMENTS)),
    foreignKey({ name: 'orders_payment_method_fk', columns: [t.tenantId, t.paymentMethodId], foreignColumns: [paymentMethods.tenantId, paymentMethods.id] }),
    check('orders_amounts_check', sql`${t.subtotalCents} >= 0 and (${t.deliveryCents} is null or ${t.deliveryCents} >= 0)`),
    check('orders_delivery_address_check', sql`${t.fulfillment} = 'pickup' or length(coalesce(${t.address}, '')) > 0`),
    check('orders_text_check', sql`length(${t.customerName}) between 1 and 80 and length(${t.notes}) <= 500 and length(coalesce(${t.address}, '')) <= 300`),
    check('orders_payment_reference_check', sql`length(coalesce(${t.paymentReference}, '')) <= 40`),
  ],
)

/** What was ordered: the product as the catalog named it then, how it was sold and its price then. */
export const orderLines = pgTable(
  'order_lines',
  {
    tenantId: tenantIdColumn(),
    orderId: uuid('order_id').notNull(),
    position: integer('position').notNull(),
    // The catalog's id for it: a variant of Vortomi's inventory, or the company's own system id.
    productRef: text('product_ref').notNull(),
    name: text('name').notNull(),
    // In the product's sale unit: 2 for pieces, 0.75 for kilos.
    quantity: quantityColumn('quantity').notNull(),
    saleUnit: text('sale_unit', { enum: SALE_UNITS }).notNull().default('unit'),
    // Per one sale unit; the line costs quantity × this, rounded to the cent (lineCents).
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [
    unique('order_lines_order_position_key').on(t.tenantId, t.orderId, t.position),
    foreignKey({ name: 'order_lines_order_fk', columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete('cascade'),
    check('order_lines_quantity_check', sql`${t.quantity} > 0 and ${t.quantity} <= 1000`),
    check('order_lines_sale_unit_check', oneOf(t.saleUnit, SALE_UNITS)),
    check('order_lines_price_check', sql`${t.unitPriceCents} >= 0`),
  ],
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * Files customers sent by WhatsApp that the platform downloaded (payment receipts, for now). Kept in
 * the database, per company, at most a few MB each: no outside storage to secure.
 */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    // Meta's id of a file a customer sent; null for the files we make (receipts) or upload (logos).
    waMediaId: text('wa_media_id'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytea('content').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('media_files_tenant_id_id_key').on(t.tenantId, t.id),
    unique('media_files_tenant_wa_media_key').on(t.tenantId, t.waMediaId),
    check('media_files_size_check', sql`${t.sizeBytes} between 1 and 5242880`),
  ],
)

/** The payment receipts a customer sent for an order. */
export const orderReceipts = pgTable(
  'order_receipts',
  {
    tenantId: tenantIdColumn(),
    orderId: uuid('order_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ name: 'order_receipts_pkey', columns: [t.tenantId, t.orderId, t.mediaId] }),
    foreignKey({ name: 'order_receipts_order_fk', columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'order_receipts_media_fk', columns: [t.tenantId, t.mediaId], foreignColumns: [mediaFiles.tenantId, mediaFiles.id] }),
  ],
)

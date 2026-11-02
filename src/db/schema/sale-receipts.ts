import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { RECEIPT_MODES } from './enums.ts'
import { mediaFiles, orders } from './orders.ts'
import { tenants } from './tenancy.ts'

// The sale receipt a company gives its customer when an order is completed (Ajustes → Recibo).
// Not a fiscal invoice: an informative proof of the sale, the same layout for every company with
// each one's own data. Its business name, RIF and address come from the company itself (tenants).

/**
 * How a company gives receipts. No row: Vortomi makes them, with what the company has. mode:
 * 'vortomi' makes and sends it on completing an order; 'own' the team uploads its own image;
 * 'off' no receipt.
 */
export const receiptSettings = pgTable(
  'receipt_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    mode: text('mode', { enum: RECEIPT_MODES }).notNull().default('vortomi'),
    // Under the name: "Sucursal Naguanagua".
    subtitle: text('subtitle').notNull().default(''),
    phone: text('phone').notNull().default(''),
    // "APC" makes APC-000050; empty: the initials of the company name.
    prefix: text('prefix').notNull().default(''),
    // Null: the suggestion for its business type (a warranty, a return policy, a thank you).
    footer: text('footer'),
    showAttendedBy: boolean('show_attended_by').notNull().default(true),
    showPaymentReference: boolean('show_payment_reference').notNull().default(true),
    logoMediaId: uuid('logo_media_id'),
    // The next receipt's number: taken and moved in the transaction that issues it, so numbers
    // follow each other without gaps or repeats.
    nextNumber: integer('next_number').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'receipt_settings_logo_fk', columns: [t.tenantId, t.logoMediaId], foreignColumns: [mediaFiles.tenantId, mediaFiles.id] }),
    check('receipt_settings_mode_check', oneOf(t.mode, RECEIPT_MODES)),
    check('receipt_settings_prefix_check', sql`${t.prefix} ~ '^[A-Z0-9]{0,6}$'`),
    check(
      'receipt_settings_text_check',
      sql`length(${t.subtitle}) <= 60 and length(${t.phone}) <= 30 and length(coalesce(${t.footer}, '')) <= 300`,
    ),
    check('receipt_settings_next_number_check', sql`${t.nextNumber} >= 1`),
  ],
)

/** The receipt an order got: one per order, written once. Uploaded ones carry no number of ours. */
export const saleReceipts = pgTable(
  'sale_receipts',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    orderId: uuid('order_id').notNull(),
    number: integer('number'),
    // "APC-000050" as printed; null when the team uploaded its own.
    code: text('code'),
    mediaId: uuid('media_id').notNull(),
    issuedBy: uuid('issued_by'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('sale_receipts_order_key').on(t.tenantId, t.orderId),
    unique('sale_receipts_number_key').on(t.tenantId, t.number),
    foreignKey({ name: 'sale_receipts_order_fk', columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    foreignKey({ name: 'sale_receipts_media_fk', columns: [t.tenantId, t.mediaId], foreignColumns: [mediaFiles.tenantId, mediaFiles.id] }),
    check('sale_receipts_number_check', sql`(${t.number} is null) = (${t.code} is null) and coalesce(${t.number}, 1) >= 1`),
  ],
)

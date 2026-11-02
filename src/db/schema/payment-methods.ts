import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, timestamptz, uuidIdColumn } from './columns.ts'
import { PAYMENT_METHOD_TYPES, PAYMENT_PROOF_RULES, type PaymentFieldKind } from './enums.ts'
import { tenants } from './tenancy.ts'

/** One datum the customer sees to pay ("Banco: 0134 · Banesco"), in the order the company set. */
export interface PaymentField {
  kind: PaymentFieldKind
  label: string
  value: string
  copyable: boolean
}

/**
 * How a company gets paid (Ajustes → Métodos de pago). Hidden, never deleted: the orders paid with
 * a method keep pointing at it. The currency follows the type (payment-method-types.ts).
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuidIdColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    type: text('type', { enum: PAYMENT_METHOD_TYPES }).notNull(),
    name: text('name').notNull(),
    fields: jsonb('fields').$type<PaymentField[]>().notNull().default(sql`'[]'::jsonb`),
    instructions: text('instructions').notNull().default(''),
    referenceRule: text('reference_rule', { enum: PAYMENT_PROOF_RULES }).notNull().default('required'),
    receiptRule: text('receipt_rule', { enum: PAYMENT_PROOF_RULES }).notNull().default('required'),
    // Offered to customers (the agent only offers these).
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('payment_methods_tenant_id_id_key').on(t.tenantId, t.id),
    index('payment_methods_tenant_order_idx').on(t.tenantId, t.sortOrder),
    check('payment_methods_type_check', oneOf(t.type, PAYMENT_METHOD_TYPES)),
    check('payment_methods_reference_rule_check', oneOf(t.referenceRule, PAYMENT_PROOF_RULES)),
    check('payment_methods_receipt_rule_check', oneOf(t.receiptRule, PAYMENT_PROOF_RULES)),
    check('payment_methods_text_check', sql`length(btrim(${t.name})) between 2 and 120 and length(${t.instructions}) <= 2000`),
    check('payment_methods_fields_check', sql`jsonb_typeof(${t.fields}) = 'array' and jsonb_array_length(${t.fields}) <= 12`),
  ],
)

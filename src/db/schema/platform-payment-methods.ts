import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, timestamptz, uuidIdColumn } from './columns.ts'
import { PAYMENT_METHOD_TYPES, PAYMENT_PROOF_RULES } from './enums.ts'
import type { PaymentField } from './payment-methods.ts'

/**
 * How companies pay Vortomi their monthly fee (console → Suscripciones → Métodos de pago). The same
 * shape and rules as a company's own methods (payment_methods), but Vortomi's: no company column,
 * only the console reads or writes it. Hidden, never deleted.
 */
export const platformPaymentMethods = pgTable(
  'platform_payment_methods',
  {
    id: uuidIdColumn(),
    type: text('type', { enum: PAYMENT_METHOD_TYPES }).notNull(),
    name: text('name').notNull(),
    fields: jsonb('fields').$type<PaymentField[]>().notNull().default(sql`'[]'::jsonb`),
    instructions: text('instructions').notNull().default(''),
    referenceRule: text('reference_rule', { enum: PAYMENT_PROOF_RULES }).notNull().default('required'),
    receiptRule: text('receipt_rule', { enum: PAYMENT_PROOF_RULES }).notNull().default('required'),
    // Shown to the companies when they pay.
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('platform_payment_methods_order_idx').on(t.sortOrder),
    check('platform_payment_methods_type_check', oneOf(t.type, PAYMENT_METHOD_TYPES)),
    check('platform_payment_methods_reference_rule_check', oneOf(t.referenceRule, PAYMENT_PROOF_RULES)),
    check('platform_payment_methods_receipt_rule_check', oneOf(t.receiptRule, PAYMENT_PROOF_RULES)),
    check('platform_payment_methods_text_check', sql`length(btrim(${t.name})) between 2 and 120 and length(${t.instructions}) <= 2000`),
    check('platform_payment_methods_fields_check', sql`jsonb_typeof(${t.fields}) = 'array' and jsonb_array_length(${t.fields}) <= 12`),
  ],
)

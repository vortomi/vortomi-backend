import { sql } from 'drizzle-orm'
import { check, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { TEMPLATE_CATEGORIES, TEMPLATE_STATUSES } from './enums.ts'
import { tenants } from './tenancy.ts'

/**
 * Message templates: the only thing that can be sent outside the 24 h window.
 * They live in a WhatsApp Business Account (waba_id), reviewed by Meta, whose
 * verdict arrives by webhook and is matched by meta_template_id.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    wabaId: text('waba_id').notNull(),
    // Assigned by Meta when it accepts the submission.
    metaTemplateId: text('meta_template_id'),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category', { enum: TEMPLATE_CATEGORIES }).notNull(),
    status: text('status', { enum: TEMPLATE_STATUSES }).notNull().default('draft'),
    rejectionReason: text('rejection_reason'),
    // Why the submission never reached Meta's review (credentials, rejected request).
    submitError: text('submit_error'),
    // Body with {{1}}, {{2}}... and one example value per parameter (Meta requires them).
    body: text('body').notNull(),
    bodyExample: jsonb('body_example').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAtColumn(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('message_templates_tenant_id_id_key').on(t.tenantId, t.id),
    unique('message_templates_tenant_waba_name_language_key').on(t.tenantId, t.wabaId, t.name, t.language),
    unique('message_templates_tenant_meta_id_key').on(t.tenantId, t.metaTemplateId),
    // Postgres caps regex repetition at 255, so the length is its own condition.
    check('message_templates_name_check', sql`${t.name} ~ '^[a-z0-9_]+$' and length(${t.name}) <= 512`),
    check('message_templates_language_check', sql`${t.language} ~ '^[a-z]{2,3}(_[A-Z]{2})?$'`),
    check('message_templates_body_check', sql`length(${t.body}) between 1 and 1024`),
    check('message_templates_category_check', oneOf(t.category, TEMPLATE_CATEGORIES)),
    check('message_templates_status_check', oneOf(t.status, TEMPLATE_STATUSES)),
  ],
)

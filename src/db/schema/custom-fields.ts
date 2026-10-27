import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, integer, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, uuidIdColumn } from './columns.ts'
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_KINDS } from './enums.ts'
import { productCategories } from './inventory.ts'
import { tenants } from './tenancy.ts'

// The company's own data about its products and customers (documentations/05, block B): it
// defines each field once, and every product or contact fills it. The values live on the
// product or contact itself (custom_values, { fieldId: value }), checked by the API.

export const customFields = pgTable(
  'custom_fields',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    // Whose data it is: the company's products or its customers.
    entity: text('entity', { enum: CUSTOM_FIELD_ENTITIES }).notNull(),
    label: text('label').notNull(),
    // How it is answered, from a closed list; it never changes once created (values depend on it).
    kind: text('kind', { enum: CUSTOM_FIELD_KINDS }).notNull(),
    required: boolean('required').notNull().default(false),
    // Order on screen.
    position: integer('position').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('custom_fields_tenant_id_id_key').on(t.tenantId, t.id),
    // "Marca" and "marca" are the same field.
    uniqueIndex('custom_fields_tenant_entity_label_key').on(t.tenantId, t.entity, sql`lower(${t.label})`),
    check('custom_fields_entity_check', oneOf(t.entity, CUSTOM_FIELD_ENTITIES)),
    check('custom_fields_kind_check', oneOf(t.kind, CUSTOM_FIELD_KINDS)),
    check('custom_fields_label_check', sql`length(trim(${t.label})) between 1 and 40`),
  ],
)

/** The choices of a list field ("Izquierdo", "Derecho"): people pick, never type. */
export const customFieldOptions = pgTable(
  'custom_field_options',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn(),
    fieldId: uuid('field_id').notNull(),
    value: text('value').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({ name: 'custom_field_options_field_fk', columns: [t.tenantId, t.fieldId], foreignColumns: [customFields.tenantId, customFields.id] }).onDelete('cascade'),
    uniqueIndex('custom_field_options_value_key').on(t.tenantId, t.fieldId, sql`lower(${t.value})`),
    check('custom_field_options_value_check', sql`length(trim(${t.value})) between 1 and 60`),
  ],
)

/** A product field shown only in some categories ("Requiere récipe" for medicines). None: all. */
export const customFieldCategories = pgTable(
  'custom_field_categories',
  {
    tenantId: tenantIdColumn(),
    fieldId: uuid('field_id').notNull(),
    categoryId: uuid('category_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'custom_field_categories_pkey', columns: [t.tenantId, t.fieldId, t.categoryId] }),
    foreignKey({ name: 'custom_field_categories_field_fk', columns: [t.tenantId, t.fieldId], foreignColumns: [customFields.tenantId, customFields.id] }).onDelete('cascade'),
    foreignKey({
      name: 'custom_field_categories_category_fk',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
    }).onDelete('cascade'),
  ],
)

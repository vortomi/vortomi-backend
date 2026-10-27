import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_KINDS, type CustomFieldEntity } from '../../db/schema/enums.ts'
import { contacts, customFieldCategories, customFieldOptions, customFields, products } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { FieldDefinition } from './custom-values.ts'

export class CustomFieldNotFoundError extends Error {
  constructor() {
    super('Field not found in this company')
    this.name = 'CustomFieldNotFoundError'
  }
}

/** Each company keeps its fields few, so every form stays short. */
export class FieldLimitError extends Error {
  constructor() {
    super(`At most ${MAX_FIELDS} fields each for products and for customers`)
    this.name = 'FieldLimitError'
  }
}

/** A field that does not make sense: a list without options, options on a text field... */
export class InvalidCustomFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCustomFieldError'
  }
}

export const MAX_FIELDS = 30
const MAX_OPTIONS = 100
const LIST_KINDS = new Set(['choice', 'multi_choice'])

const optionValue = z.string().trim().min(1).max(60)

export const fieldInput = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(CUSTOM_FIELD_KINDS),
  required: z.boolean().default(false),
  // List fields only: their choices, in order.
  options: z.array(optionValue).max(MAX_OPTIONS).default([]),
  // Product fields only: the categories it shows in; none: all of them.
  categoryIds: z.array(z.uuid()).max(100).default([]),
})
export type FieldInput = z.infer<typeof fieldInput>

/** The kind never changes (the stored values depend on it); options keep their id when renamed. */
export const fieldUpdate = z.object({
  label: z.string().trim().min(1).max(40),
  required: z.boolean(),
  options: z.array(z.object({ id: z.uuid().optional(), value: optionValue })).max(MAX_OPTIONS).default([]),
  categoryIds: z.array(z.uuid()).max(100).default([]),
})
export type FieldUpdate = z.infer<typeof fieldUpdate>

export const entityQuery = z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES) })

/** "Dirección", "dirección " and "Direccion:" are the same note. */
export function noteKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s.:]+$/g, '')
    .trim()
}

/** The table that holds the values of an entity's fields. */
const valuesTable = (entity: CustomFieldEntity) => (entity === 'product' ? products : contacts)

/**
 * The company's own fields for its products and customers (block B). Everyone reads them; the
 * routes let only admins change them. Removing a field or an option also removes its values,
 * so no product or contact keeps an answer nobody can see or pick again.
 */
export class CustomFieldService {
  async list(scope: MemberScope, entity: CustomFieldEntity) {
    const { tx, tenantId } = scope
    const fields = await tx
      .select({ id: customFields.id, entity: customFields.entity, label: customFields.label, kind: customFields.kind, required: customFields.required, position: customFields.position })
      .from(customFields)
      .where(and(eq(customFields.tenantId, tenantId), eq(customFields.entity, entity)))
      .orderBy(asc(customFields.position), asc(customFields.createdAt))
    if (!fields.length) return []
    const ids = fields.map((f) => f.id)
    const [options, categories] = await Promise.all([
      tx
        .select({ id: customFieldOptions.id, fieldId: customFieldOptions.fieldId, value: customFieldOptions.value })
        .from(customFieldOptions)
        .where(and(eq(customFieldOptions.tenantId, tenantId), inArray(customFieldOptions.fieldId, ids)))
        .orderBy(asc(customFieldOptions.position), asc(customFieldOptions.createdAt)),
      tx
        .select({ fieldId: customFieldCategories.fieldId, categoryId: customFieldCategories.categoryId })
        .from(customFieldCategories)
        .where(and(eq(customFieldCategories.tenantId, tenantId), inArray(customFieldCategories.fieldId, ids))),
    ])
    return fields.map((field) => ({
      ...field,
      options: options.filter((o) => o.fieldId === field.id).map(({ id, value }) => ({ id, value })),
      categoryIds: categories.filter((c) => c.fieldId === field.id).map((c) => c.categoryId),
    }))
  }

  /** What checkValues needs to check the values of an entity. */
  async definitions(scope: MemberScope, entity: CustomFieldEntity): Promise<FieldDefinition[]> {
    return (await this.list(scope, entity)).map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.kind,
      required: field.required,
      optionIds: new Set(field.options.map((o) => o.id)),
      categoryIds: field.categoryIds,
    }))
  }

  async create(scope: MemberScope, input: FieldInput) {
    const { tx, tenantId } = scope
    this.assertShape(input.entity, input.kind, input.options.length, input.categoryIds.length)
    const [existing] = await tx
      .select({ total: count(), last: sql<number>`coalesce(max(${customFields.position}), -1)`.mapWith(Number) })
      .from(customFields)
      .where(and(eq(customFields.tenantId, tenantId), eq(customFields.entity, input.entity)))
    if ((existing?.total ?? 0) >= MAX_FIELDS) throw new FieldLimitError()
    const [field] = await tx
      .insert(customFields)
      .values({ tenantId, entity: input.entity, label: input.label, kind: input.kind, required: input.required, position: (existing?.last ?? -1) + 1 })
      .returning({ id: customFields.id })
    await this.insertOptions(scope, field!.id, input.options, 0)
    await this.setCategories(scope, field!.id, input.categoryIds)
    return this.one(scope, input.entity, field!.id)
  }

  async update(scope: MemberScope, fieldId: string, input: FieldUpdate) {
    const { tx, tenantId } = scope
    const field = await this.find(scope, fieldId)
    this.assertShape(field.entity, field.kind, input.options.length, input.categoryIds.length)
    await tx.update(customFields).set({ label: input.label, required: input.required }).where(and(eq(customFields.tenantId, tenantId), eq(customFields.id, fieldId)))

    const current = await tx
      .select({ id: customFieldOptions.id })
      .from(customFieldOptions)
      .where(and(eq(customFieldOptions.tenantId, tenantId), eq(customFieldOptions.fieldId, fieldId)))
    const currentIds = new Set(current.map((o) => o.id))
    const keptIds = new Set(input.options.flatMap((o) => (o.id ? [o.id] : [])))
    if ([...keptIds].some((id) => !currentIds.has(id))) throw new InvalidCustomFieldError('An option of another field')
    const removed = [...currentIds].filter((id) => !keptIds.has(id))
    if (removed.length) {
      await tx.delete(customFieldOptions).where(and(eq(customFieldOptions.tenantId, tenantId), inArray(customFieldOptions.id, removed)))
      for (const optionId of removed) await this.stripOption(scope, field.entity, fieldId, optionId)
    }
    // Renamed in two steps so a swap of two names never collides on the unique key.
    for (const [position, option] of input.options.entries()) {
      if (option.id) await tx.update(customFieldOptions).set({ value: `~${option.id}`, position }).where(eq(customFieldOptions.id, option.id))
    }
    for (const [position, option] of input.options.entries()) {
      if (option.id) await tx.update(customFieldOptions).set({ value: option.value, position }).where(eq(customFieldOptions.id, option.id))
      else await this.insertOptions(scope, fieldId, [option.value], position)
    }
    await tx.delete(customFieldCategories).where(and(eq(customFieldCategories.tenantId, tenantId), eq(customFieldCategories.fieldId, fieldId)))
    await this.setCategories(scope, fieldId, input.categoryIds)
    return this.one(scope, field.entity, fieldId)
  }

  /** The field, its options and every value given to it. */
  async remove(scope: MemberScope, fieldId: string) {
    const field = await this.find(scope, fieldId)
    await scope.tx.delete(customFields).where(and(eq(customFields.tenantId, scope.tenantId), eq(customFields.id, fieldId)))
    await scope.tx.execute(sql`
      update ${valuesTable(field.entity)} set custom_values = custom_values - ${fieldId}::text
       where tenant_id = ${scope.tenantId}::uuid and jsonb_exists(custom_values, ${fieldId}::text)`)
  }

  /**
   * Notes typed freely on contacts before the company had fields, grouped by name ("Dirección",
   * "direccion:"), most used first: what an admin can turn into fields.
   */
  async notes(scope: MemberScope) {
    const rows = await scope.tx
      .select({ attributes: contacts.attributes })
      .from(contacts)
      .where(and(eq(contacts.tenantId, scope.tenantId), sql`jsonb_array_length(${contacts.attributes}) > 0`))
    const groups = new Map<string, { label: string; count: number }>()
    for (const { attributes } of rows) {
      for (const note of attributes) {
        if (!note.value.trim()) continue
        const key = noteKey(note.label)
        const group = groups.get(key) ?? { label: note.label.trim(), count: 0 }
        group.count++
        groups.set(key, group)
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'))
  }

  /**
   * Moves the notes named like `label` into the customers' text field of that name (created if
   * missing): every contact gets the value, unless it already answered that field, and the note
   * goes away. Resolves to the field and how many contacts got the value.
   */
  async organizeNotes(scope: MemberScope, label: string) {
    const { tx, tenantId } = scope
    const key = noteKey(label)
    const fields = await this.list(scope, 'contact')
    let field = fields.find((f) => noteKey(f.label) === key)
    if (field && field.kind !== 'text') throw new InvalidCustomFieldError('Notes can only go into a text field')
    field ??= await this.create(scope, { entity: 'contact', label: label.trim().slice(0, 40), kind: 'text', required: false, options: [], categoryIds: [] })

    const rows = await tx
      .select({ id: contacts.id, attributes: contacts.attributes, customValues: contacts.customValues })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), sql`jsonb_array_length(${contacts.attributes}) > 0`))
    let moved = 0
    for (const row of rows) {
      const matching = row.attributes.filter((note) => noteKey(note.label) === key)
      if (!matching.length) continue
      const value = matching.map((note) => note.value.trim()).find(Boolean)
      const customValues = { ...row.customValues }
      if (value && !(field.id in customValues)) {
        customValues[field.id] = value.slice(0, 200)
        moved++
      }
      const attributes = row.attributes.filter((note) => noteKey(note.label) !== key)
      await tx.update(contacts).set({ attributes, customValues }).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, row.id)))
    }
    return { field, moved }
  }

  private assertShape(entity: CustomFieldEntity, kind: string, options: number, categories: number) {
    if (LIST_KINDS.has(kind) && !options) throw new InvalidCustomFieldError('A list needs at least one option')
    if (!LIST_KINDS.has(kind) && options) throw new InvalidCustomFieldError('Only list fields have options')
    if (entity !== 'product' && categories) throw new InvalidCustomFieldError('Only product fields go by category')
  }

  private async insertOptions(scope: MemberScope, fieldId: string, values: string[], from: number) {
    if (!values.length) return
    await scope.tx.insert(customFieldOptions).values(values.map((value, i) => ({ tenantId: scope.tenantId, fieldId, value, position: from + i })))
  }

  private async setCategories(scope: MemberScope, fieldId: string, categoryIds: string[]) {
    const unique = [...new Set(categoryIds)]
    if (unique.length) await scope.tx.insert(customFieldCategories).values(unique.map((categoryId) => ({ tenantId: scope.tenantId, fieldId, categoryId })))
  }

  /** An option taken off a list is taken off every answer that picked it. */
  private async stripOption(scope: MemberScope, entity: CustomFieldEntity, fieldId: string, optionId: string) {
    const table = valuesTable(entity)
    const mine = sql`tenant_id = ${scope.tenantId}::uuid and jsonb_exists(custom_values, ${fieldId}::text)`
    await scope.tx.execute(sql`
      update ${table} set custom_values = custom_values - ${fieldId}::text
       where ${mine} and custom_values ->> ${fieldId}::text = ${optionId}::text`)
    await scope.tx.execute(sql`
      update ${table} set custom_values = jsonb_set(custom_values, array[${fieldId}::text], (custom_values -> ${fieldId}::text) - ${optionId}::text)
       where ${mine} and jsonb_typeof(custom_values -> ${fieldId}::text) = 'array'`)
    await scope.tx.execute(sql`
      update ${table} set custom_values = custom_values - ${fieldId}::text
       where ${mine} and custom_values -> ${fieldId}::text = '[]'::jsonb`)
  }

  private async find(scope: MemberScope, fieldId: string) {
    const [field] = await scope.tx
      .select({ entity: customFields.entity, kind: customFields.kind })
      .from(customFields)
      .where(and(eq(customFields.tenantId, scope.tenantId), eq(customFields.id, fieldId)))
    if (!field) throw new CustomFieldNotFoundError()
    return field
  }

  private async one(scope: MemberScope, entity: CustomFieldEntity, fieldId: string) {
    const field = (await this.list(scope, entity)).find((f) => f.id === fieldId)
    if (!field) throw new CustomFieldNotFoundError()
    return field
  }
}


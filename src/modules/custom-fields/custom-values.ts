import { z } from 'zod'
import type { CustomValue } from '../../db/schema/columns.ts'
import type { CustomFieldKind } from '../../db/schema/enums.ts'

/** A value that does not fit its field: wrong type, an option of another list, a required one missing. */
export class InvalidCustomValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCustomValueError'
  }
}

/** What the API needs of a field to check a value against it. */
export interface FieldDefinition {
  id: string
  label: string
  kind: CustomFieldKind
  required: boolean
  optionIds: ReadonlySet<string>
  /** Product fields shown only in these categories; empty: everywhere. */
  categoryIds: readonly string[]
}

/** As sent by the panel: field id to value. Checked against the company's fields by checkValues. */
export const customValuesInput = z
  .record(z.uuid(), z.unknown())
  .refine((values) => Object.keys(values).length <= 60, 'too many values')

const MAX_TEXT = 200
const MAX_NUMBER = 1e12
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Empty answers are no answer: they are left out instead of stored. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** One value checked and normalized for its field; throws when it does not fit. */
function checkOne(field: FieldDefinition, value: unknown): CustomValue {
  const wrong = (what: string) => new InvalidCustomValueError(`"${field.label}": ${what}`)
  switch (field.kind) {
    case 'text': {
      if (typeof value !== 'string') throw wrong('expected text')
      const text = value.trim()
      if (text.length > MAX_TEXT) throw wrong(`at most ${MAX_TEXT} characters`)
      return text
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) throw wrong('expected a number')
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw wrong('expected yes or no')
      return value
    case 'date':
      if (typeof value !== 'string' || !isRealDay(value)) throw wrong('expected a date, YYYY-MM-DD')
      return value
    case 'choice':
      if (typeof value !== 'string' || !field.optionIds.has(value)) throw wrong('not one of its options')
      return value
    case 'multi_choice': {
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !field.optionIds.has(id))) throw wrong('not options of its list')
      return [...new Set(value as string[])]
    }
  }
}

/**
 * The values to store for a product (its category) or a contact (`categoryId` undefined): only
 * fields of this company, checked and normalized; fields that do not apply to the category are
 * dropped; empty answers are left out; required fields that apply must be answered.
 */
export function checkValues(fields: readonly FieldDefinition[], input: Record<string, unknown>, categoryId?: string | null): Record<string, CustomValue> {
  const byId = new Map(fields.map((field) => [field.id, field]))
  const applies = (field: FieldDefinition) => categoryId === undefined || !field.categoryIds.length || (!!categoryId && field.categoryIds.includes(categoryId))
  const stored: Record<string, CustomValue> = {}
  for (const [fieldId, value] of Object.entries(input)) {
    const field = byId.get(fieldId)
    if (!field) throw new InvalidCustomValueError('A value for a field this company does not have')
    if (!applies(field) || isEmpty(value)) continue
    const checked = checkOne(field, value)
    if (!isEmpty(checked)) stored[fieldId] = checked
  }
  for (const field of fields) {
    if (field.required && applies(field) && !(field.id in stored)) throw new InvalidCustomValueError(`"${field.label}" is required`)
  }
  return stored
}

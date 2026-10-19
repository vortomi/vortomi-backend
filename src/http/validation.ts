import type { z } from 'zod'
import { ApiError } from './errors.ts'

/** Parses request input with zod; a mismatch is a 400 that names the fields, never echoes values. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
    throw new ApiError(400, 'invalid_request', `Invalid fields: ${fields.join(', ')}`)
  }
  return parsed.data
}

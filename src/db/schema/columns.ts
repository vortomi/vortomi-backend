import { sql, type SQL } from 'drizzle-orm'
import { bigint, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

/** Random UUID key: ids that leave the server must not be guessable or enumerable. */
export const uuidIdColumn = () => uuid('id').primaryKey().defaultRandom()

/** Sequential key for high-volume internal rows (messages, events); never exposed alone. */
export const serialIdColumn = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity()

/** Every tenant-owned row carries it; RLS and the composite foreign keys hang from it. */
export const tenantIdColumn = () => uuid('tenant_id').notNull()

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const createdAtColumn = () => timestamptz('created_at').notNull().defaultNow()

/**
 * CHECK expression restricting a text column to a fixed list.
 * Values come from code constants (enums.ts), never from user input, so
 * inlining them as SQL literals is safe.
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')
  return sql`${column} in (${sql.raw(list)})`
}

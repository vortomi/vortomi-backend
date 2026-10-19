import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

/**
 * Driver-agnostic database type: production uses postgres-js against
 * Supabase, tests use PGlite. Services depend on this type only.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Anything that can run a query: the database itself or an open transaction. */
export type Executor = Database | Transaction

export interface DatabaseHandle {
  db: Database
  close: () => Promise<void>
}

export function createDatabase(url: string, maxConnections: number): DatabaseHandle {
  const client = postgres(url, {
    max: maxConnections,
    // Supabase requires TLS; the connection string carries sslmode.
    connection: { application_name: 'vortomi-backend' },
  })
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  }
}

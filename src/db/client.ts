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
  /** LISTEN on a channel over a connection of its own; resolves to the function that stops it. */
  listen: (channel: string, onNotice: (payload: string) => void) => Promise<() => Promise<void>>
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
    listen: async (channel, onNotice) => {
      const request = await client.listen(channel, onNotice)
      return () => request.unlisten()
    },
    close: () => client.end({ timeout: 5 }),
  }
}

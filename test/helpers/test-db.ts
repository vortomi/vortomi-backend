import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Database } from '../../src/db/client.ts'
import * as schema from '../../src/db/schema/index.ts'

export interface TestDatabase {
  db: Database
  client: PGlite
  close: () => Promise<void>
}

/**
 * Fresh in-memory Postgres with the real migrations applied, so tests exercise
 * the same constraints production has.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite()
  const pglite = drizzle(client, { schema })
  await migrate(pglite, { migrationsFolder: 'drizzle' })
  return {
    // PGlite's result type differs from postgres-js only in driver metadata.
    db: pglite as unknown as Database,
    client,
    close: () => client.close(),
  }
}

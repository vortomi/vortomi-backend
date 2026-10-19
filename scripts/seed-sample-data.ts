// Loads the prototype's sample companies into an EMPTY development database.
//
//   npm run db:seed-sample
//
// Refuses to run with NODE_ENV=production or when companies already exist. The sample
// people have no Supabase account: they show the data, they cannot sign in.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/db/client.ts'
import { tenants } from '../src/db/schema/index.ts'
import { seedSampleData } from './lib/sample-data.ts'

const DATA_DIR = fileURLToPath(new URL('../../vortomi-frontend/public/data', import.meta.url))

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  if (process.env.NODE_ENV === 'production') throw new Error('Sample data never goes into production')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is missing in .env')

  const database = createDatabase(url, 1)
  try {
    const existing = await database.db.select({ id: tenants.id }).from(tenants).limit(1)
    if (existing.length) throw new Error('The database already has companies; sample data only goes into an empty one')
    const summary = await seedSampleData(database.db, DATA_DIR)
    // eslint-disable-next-line no-console
    console.log('Sample data loaded:', summary)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

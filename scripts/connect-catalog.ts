// Connects a company to its own catalog system: the sales agent then reads that company's
// products, prices and availability live from it, instead of from Vortomi's inventory.
//
//   npm run catalog:connect -- --tenant-slug la-campina --kind lacampina_v1 --base-url https://aguapotablelacampina.com/api/v1
//
// The API key is read from standard input, never from the command line, so it does not end up in
// the shell history or the process list. It is checked with one read-only request, then stored
// encrypted. Needs DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY in .env.
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDatabase } from '../src/db/client.ts'
import { CATALOG_SOURCE_KINDS } from '../src/db/schema/enums.ts'
import { tenants } from '../src/db/schema/index.ts'
import { CredentialCipher } from '../src/modules/channels/credential-cipher.ts'
import { CatalogSources } from '../src/modules/catalog-source/catalog-sources.ts'
import { CatalogCache } from '../src/modules/catalog-source/external-catalog.ts'
import { readLaCampinaCatalog } from '../src/modules/catalog-source/lacampina-client.ts'

async function readKey(): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false })
  try {
    for await (const line of lines) if (line.trim()) return line.trim()
  } finally {
    lines.close()
  }
  throw new Error('No API key received on standard input')
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const env = z.object({ DATABASE_URL: z.string().min(1), CREDENTIALS_ENCRYPTION_KEY: z.string().min(1) }).parse(process.env)
  const { values } = parseArgs({ options: { 'tenant-slug': { type: 'string' }, kind: { type: 'string' }, 'base-url': { type: 'string' } }, strict: true })
  const slug = z.string().min(1).parse(values['tenant-slug'])
  const kind = z.enum(CATALOG_SOURCE_KINDS).parse(values.kind)
  const baseUrl = z.url({ protocol: /^https$/ }).parse(values['base-url']).replace(/\/+$/, '')
  const apiKey = await readKey()

  // One read-only request: a wrong key or address stops here, before anything is stored.
  const { catalog } = await readLaCampinaCatalog(baseUrl, apiKey)
  const database = createDatabase(env.DATABASE_URL, 1)
  try {
    const [tenant] = await database.db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.slug, slug))
    if (!tenant) throw new Error(`No company with slug ${slug}`)
    const cache = new CatalogCache({ ttlMs: 0, staleMaxMs: 0, minRemaining: 0 })
    await new CatalogSources(database.db, new CredentialCipher(env.CREDENTIALS_ENCRYPTION_KEY), cache).connect(tenant.id, kind, baseUrl, apiKey)
    // eslint-disable-next-line no-console
    console.log(`Connected ${tenant.name}: ${catalog.products.length} products read, rate ${catalog.bsPerUsd} Bs/USD`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

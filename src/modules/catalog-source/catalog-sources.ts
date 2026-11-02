import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { CatalogSourceKind } from '../../db/schema/enums.ts'
import { catalogSources } from '../../db/schema/index.ts'
import type { CredentialCipher } from '../channels/credential-cipher.ts'
import type { SystemRate } from '../exchange-rates/exchange-rate-service.ts'
import type { CachedCatalog, CatalogCache } from './external-catalog.ts'
import { readLaCampinaCatalog } from './lacampina-client.ts'

/** What the agent learns about a company's catalog source. */
export type CatalogLookup =
  /** The company sells from Vortomi's own inventory. */
  | { source: 'inventory' }
  /** The company's own system; catalog null when it cannot be read and nothing recent is kept. */
  | { source: 'external'; catalog: CachedCatalog | null }

/**
 * Companies whose catalog lives in their own system. Platform-side, like ChannelCredentials: the
 * table is not granted to company code, and the key is decrypted only for the call to that system,
 * never logged, returned by the API or kept in memory.
 */
export class CatalogSources {
  constructor(
    private readonly db: Database,
    private readonly cipher: CredentialCipher,
    private readonly cache: CatalogCache,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Binds the ciphertext to its company. */
  private static context(tenantId: string): string {
    return `catalog-source:${tenantId}`
  }

  async connect(tenantId: string, kind: CatalogSourceKind, baseUrl: string, apiKey: string): Promise<void> {
    const encryptedApiKey = this.cipher.encrypt(apiKey, CatalogSources.context(tenantId))
    await this.db
      .insert(catalogSources)
      .values({ tenantId, kind, baseUrl, encryptedApiKey })
      .onConflictDoUpdate({ target: catalogSources.tenantId, set: { kind, baseUrl, encryptedApiKey, updatedAt: sql`now()` } })
  }

  async lookup(tenantId: string): Promise<CatalogLookup> {
    const [source] = await this.db
      .select({ kind: catalogSources.kind, baseUrl: catalogSources.baseUrl, encryptedApiKey: catalogSources.encryptedApiKey })
      .from(catalogSources)
      .where(eq(catalogSources.tenantId, tenantId))
    if (!source) return { source: 'inventory' }
    const catalog = await this.cache.get(tenantId, () => {
      const apiKey = this.cipher.decrypt(source.encryptedApiKey, CatalogSources.context(tenantId))
      // One adapter per kind; lacampina_v1 is the only one so far.
      return readLaCampinaCatalog(source.baseUrl, apiKey, this.fetchFn)
    })
    return { source: 'external', catalog }
  }

  /**
   * The rate the company's own system prices with, as the agent uses it (2 decimals); null
   * without a system. Shares the catalog cache: it costs no extra request to that system.
   */
  async systemRate(tenantId: string): Promise<SystemRate | null> {
    const lookup = await this.lookup(tenantId)
    if (lookup.source === 'inventory') return null
    return { bsPerUsd: lookup.catalog?.bsPerUsd.toFixed(2) ?? null, rateDate: lookup.catalog?.rateDate ?? null }
  }
}

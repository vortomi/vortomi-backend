import type { CatalogRead } from './lacampina-client.ts'
import { CatalogSourceError } from './lacampina-client.ts'

/** A product as a company's own system reports it, in our words. */
export interface ExternalProduct {
  id: string
  name: string
  /** refill: filling a container (no counted stock); unit: an item with counted stock. */
  kind: 'refill' | 'unit'
  priceUsd: number
  priceVes: number
  available: boolean
  /** Units left (unit products); null when the system does not count them. */
  stock: number | null
}

export interface ExternalCatalog {
  /** The rate the system priced the bolívares with. */
  bsPerUsd: number
  rateDate: string
  products: ExternalProduct[]
}

export interface CachedCatalog extends ExternalCatalog {
  fetchedAt: Date
  /** Older than the fresh window: the system could not be read just now. */
  stale: boolean
}

export interface CatalogCacheOptions {
  /** A catalog this young is served without asking (spec: 90 s). */
  ttlMs: number
  /** An older catalog is still served, marked stale, while the system fails (spec: 10 min). */
  staleMaxMs: number
  /** Below this many requests left in the system's minute, stop refreshing until the next one. */
  minRemaining: number
  /** Told each failed read (the key is never part of the error): a silent failure looks like a quiet bot. */
  onError?: (key: string, error: unknown) => void
  now?: () => number
}

interface Entry {
  catalog: ExternalCatalog | null
  fetchedAt: number
  /** No refresh before this moment (rate limit nearly spent, or the system asked us to wait). */
  pausedUntil: number
  inFlight: Promise<void> | null
}

/**
 * One catalog per company in memory, so a burst of customer messages costs the company's system
 * one request: fresh for ttlMs, refreshed by a single request however many ask at once, and served
 * stale for a while when the system fails or its rate limit runs low.
 */
export class CatalogCache {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  constructor(private readonly options: CatalogCacheOptions) {
    this.now = options.now ?? Date.now
  }

  /** The catalog to answer with; null when there is none usable (never read, or too old). */
  async get(key: string, read: () => Promise<CatalogRead>): Promise<CachedCatalog | null> {
    const entry = this.entries.get(key) ?? { catalog: null, fetchedAt: 0, pausedUntil: 0, inFlight: null }
    this.entries.set(key, entry)
    const now = this.now()
    if (!entry.catalog || now - entry.fetchedAt >= this.options.ttlMs) {
      if (now >= entry.pausedUntil) {
        entry.inFlight ??= this.refresh(key, entry, read).finally(() => {
          entry.inFlight = null
        })
        await entry.inFlight
      }
    }
    return this.usable(entry)
  }

  private async refresh(key: string, entry: Entry, read: () => Promise<CatalogRead>): Promise<void> {
    try {
      const { catalog, remaining } = await read()
      entry.catalog = catalog
      entry.fetchedAt = this.now()
      if (remaining !== null && remaining < this.options.minRemaining) entry.pausedUntil = nextMinute(this.now())
    } catch (error) {
      this.options.onError?.(key, error)
      if (error instanceof CatalogSourceError && error.status === 429) {
        entry.pausedUntil = this.now() + (error.retryAfterSeconds ?? 60) * 1000
      }
      // Anything else: keep what we had; the next request tries again.
    }
  }

  private usable(entry: Entry): CachedCatalog | null {
    if (!entry.catalog) return null
    const age = this.now() - entry.fetchedAt
    if (age >= this.options.staleMaxMs) return null
    return { ...entry.catalog, fetchedAt: new Date(entry.fetchedAt), stale: age >= this.options.ttlMs }
  }
}

const nextMinute = (at: number) => (Math.floor(at / 60_000) + 1) * 60_000

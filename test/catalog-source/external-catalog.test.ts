// A company's own catalog system (La Campiña's API): read only, normalized, kept in memory so a
// burst of messages costs it one request, served stale while it fails, and never with the key in
// anything we log or return. Fixture: the real answer of 29/10/2026 (spec, section 3.4).
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogSources } from '../../src/db/schema/index.ts'
import { externalCatalog } from '../../src/modules/agent/agent-catalog.ts'
import { CredentialCipher } from '../../src/modules/channels/credential-cipher.ts'
import { CatalogSources } from '../../src/modules/catalog-source/catalog-sources.ts'
import { CatalogCache } from '../../src/modules/catalog-source/external-catalog.ts'
import { CatalogSourceError, readLaCampinaCatalog } from '../../src/modules/catalog-source/lacampina-client.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

const KEY = 'lcp_test_key_that_must_never_leak_0123456789abcd'
const BASE = 'https://example.test/api/v1'
const FIXTURE = {
  tasa_bcv: { valor: 888.1183, fecha: '2026-10-28T23:10:27.773Z' },
  productos: [
    { id: 'p1', nombre: 'Recarga 19L', tipo: 'recarga', precio_usd: 0.9, precio_bs: 799.31, disponible: true, existencia: null },
    { id: 'p4', nombre: 'Recarga 5L', tipo: 'recarga', precio_usd: 0.6, precio_bs: 532.87, disponible: true, existencia: null },
    { id: 'p5', nombre: 'Botellón Nuevo', tipo: 'unidad', precio_usd: 8.0, precio_bs: 7104.95, disponible: true, existencia: 12 },
    { id: 'p6', nombre: 'Bolsa de Hielo', tipo: 'unidad', precio_usd: 2.0, precio_bs: 1776.24, disponible: false, existencia: 0 },
  ],
}

/** Plays La Campiña: answers with the fixture (or what a test sets) and counts the requests. */
function fakeApi(responses: (() => Response)[] = []) {
  const calls: { url: string; auth: string | null }[] = []
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    const next = responses.shift()
    return Promise.resolve(next ? next() : Response.json(FIXTURE, { headers: { 'x-ratelimit-remaining': '58' } }))
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('reading La Campiña', () => {
  it('reads the catalog with the key in the header and normalizes it', async () => {
    const api = fakeApi()
    const { catalog, remaining } = await readLaCampinaCatalog(`${BASE}/`, KEY, api.fetchFn)
    expect(api.calls).toEqual([{ url: `${BASE}/productos`, auth: `Bearer ${KEY}` }])
    expect(remaining).toBe(58)
    expect(catalog.bsPerUsd).toBe(888.1183)
    expect(catalog.products[0]).toEqual({ id: 'p1', name: 'Recarga 19L', kind: 'refill', priceUsd: 0.9, priceVes: 799.31, available: true, stock: null })
    expect(catalog.products[2]).toMatchObject({ kind: 'unit', stock: 12 })
  })

  it('retries a 503, refuses a malformed answer, and never puts the key in an error', async () => {
    const busy = () => new Response('', { status: 503 })
    expect((await readLaCampinaCatalog(BASE, KEY, fakeApi([busy]).fetchFn)).catalog.products).toHaveLength(4)
    const errors = await Promise.all([
      readLaCampinaCatalog(BASE, KEY, fakeApi([() => Response.json({ productos: 'nope' })]).fetchFn).catch((e: unknown) => e),
      readLaCampinaCatalog(BASE, KEY, fakeApi([() => Response.json({ error: { codigo: 'no_autorizado' } }, { status: 401 })]).fetchFn).catch((e: unknown) => e),
    ])
    for (const error of errors) {
      expect(error).toBeInstanceOf(CatalogSourceError)
      expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain(KEY)
    }
  })
})

describe('the catalog in memory', () => {
  const read = (api: ReturnType<typeof fakeApi>) => () => readLaCampinaCatalog(BASE, KEY, api.fetchFn)

  it('ten customers at once cost one request; a fresh catalog is not asked again', async () => {
    let now = 0
    const cache = new CatalogCache({ ttlMs: 90_000, staleMaxMs: 600_000, minRemaining: 10, now: () => now })
    const api = fakeApi()
    const all = await Promise.all(Array.from({ length: 10 }, () => cache.get('t', read(api))))
    expect(api.calls).toHaveLength(1)
    expect(all.every((c) => c?.products.length === 4 && !c.stale)).toBe(true)
    now = 60_000
    await cache.get('t', read(api))
    expect(api.calls).toHaveLength(1)
  })

  it('while the system fails, the last catalog is served stale for ten minutes, then nothing', async () => {
    let now = 0
    const cache = new CatalogCache({ ttlMs: 90_000, staleMaxMs: 600_000, minRemaining: 10, now: () => now })
    const down = () => new Response('', { status: 500 })
    const api = fakeApi([() => Response.json(FIXTURE), down, down])
    await cache.get('t', read(api))
    now = 120_000
    expect(await cache.get('t', read(api))).toMatchObject({ stale: true })
    now = 700_000
    expect(await cache.get('t', read(api))).toBeNull()
  })

  it('stops asking when its per-minute budget runs low or it asks us to wait', async () => {
    let now = 0
    const cache = new CatalogCache({ ttlMs: 1_000, staleMaxMs: 600_000, minRemaining: 10, now: () => now })
    const api = fakeApi([() => Response.json(FIXTURE, { headers: { 'x-ratelimit-remaining': '5' } })])
    await cache.get('t', read(api))
    now = 30_000
    expect(await cache.get('t', read(api))).toMatchObject({ stale: true })
    expect(api.calls).toHaveLength(1)
  })
})

describe('what the agent sees', () => {
  it('a small catalog goes whole into the prompt; a number finds its size and nothing else', async () => {
    const catalog = (await new CatalogCache({ ttlMs: 90_000, staleMaxMs: 600_000, minRemaining: 10 }).get('t', () => readLaCampinaCatalog(BASE, KEY, fakeApi().fetchFn)))!
    const view = externalCatalog(catalog)
    expect(view.bsPerUsd).toBe('888.12')
    expect((await view.forPrompt('hola')).products).toHaveLength(4)
    const found = await view.search('recarga de 19 litros')
    expect(JSON.stringify(found)).toContain('Recarga 19L')
    expect((await view.search('19')).products).toEqual([{ name: 'Recarga 19L', type: 'refill (filling the customer container)', priceUsd: '0.90', priceBs: '799.31', availability: 'can be ordered today' }])
    expect(JSON.stringify(await view.search('hielo'))).toContain('out of stock')
  })

  it('without «Usar la tasa de mi sistema», every Bs price comes from the dollar one at the company rate', async () => {
    const catalog = (await new CatalogCache({ ttlMs: 90_000, staleMaxMs: 600_000, minRemaining: 10 }).get('t', () => readLaCampinaCatalog(BASE, KEY, fakeApi().fetchFn)))!
    const own = externalCatalog(catalog, { from: 'company', bsPerUsd: '900.00' })
    expect(own.bsPerUsd).toBe('900.00')
    expect((await own.search('19')).products).toEqual([{ name: 'Recarga 19L', type: 'refill (filling the customer container)', priceUsd: '0.90', priceBs: '810.00', availability: 'can be ordered today' }])
    const noRate = externalCatalog(catalog, { from: 'company', bsPerUsd: null })
    expect(noRate.bsPerUsd).toBeNull()
    expect((await noRate.search('19')).products).toEqual([expect.objectContaining({ priceUsd: '0.90', priceBs: undefined })])
  })

  it('an unreadable catalog tells the agent not to give prices', async () => {
    expect((await externalCatalog(null).forPrompt('precio')).note).toContain('Do not give prices')
  })
})

describe('connecting a company', () => {
  let t: TestDatabase
  let a: SeededTenant
  let b: SeededTenant
  beforeAll(async () => {
    t = await createTestDatabase()
    ;({ a, b } = await seedTwoTenants(t.db))
  })
  afterAll(async () => {
    await t.close()
  })

  it('stores the key encrypted, reads with it, and only for that company', async () => {
    const api = fakeApi()
    const sources = new CatalogSources(t.db, new CredentialCipher(Buffer.alloc(32, 7).toString('base64')), new CatalogCache({ ttlMs: 90_000, staleMaxMs: 600_000, minRemaining: 10 }), api.fetchFn)
    await sources.connect(a.tenantId, 'lacampina_v1', BASE, KEY)
    const [row] = await t.db.select().from(catalogSources).where(eq(catalogSources.tenantId, a.tenantId))
    expect(row!.encryptedApiKey).not.toContain(KEY)
    expect(await sources.lookup(a.tenantId)).toMatchObject({ source: 'external', catalog: { bsPerUsd: 888.1183 } })
    expect(api.calls[0]!.auth).toBe(`Bearer ${KEY}`)
    expect(await sources.lookup(b.tenantId)).toEqual({ source: 'inventory' })
  })
})

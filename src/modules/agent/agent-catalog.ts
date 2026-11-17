import { type AnyColumn, type SQL, and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { productCategories, productVariants, products } from '../../db/schema/index.ts'
import { likePattern } from '../../shared/pagination.ts'
import type { CachedCatalog, ExternalProduct } from '../catalog-source/external-catalog.ts'
import { type SaleRule, UNIT_RULE, takesDecimals } from '../inventory/sale-quantity.ts'
import { withTenant } from '../tenancy/tenant-scope.ts'
import { unitText } from './agent-prompt.ts'

const MAX_PRODUCTS = 6
const MAX_VARIANTS = 12
/** Words shorter than this ("de", "la") would match half the catalog. */
const MIN_WORD = 3
/** A catalog this small (Vortomi's inventory or a company's own) goes whole into the prompt, and asking for
 * «la lista» gives at most this many (decided 17 Nov 2026: 50). */
const WHOLE_CATALOG = 50

/** Products as the model reads them, plus a note when it must know something about them. */
export interface CatalogAnswer {
  products: unknown[]
  note?: string
  /** The company's own system cannot be read now (and nothing recent is kept). */
  unavailable?: boolean
}

/** Where the agent reads a company's products: Vortomi's inventory or the company's own system. */
export interface AgentCatalog {
  /** Bolívares per dollar the prices use, as text; null when unknown. */
  readonly bsPerUsd: string | null
  /** Shown before asking the model: the products the customer's words point to (or all, if few). */
  forPrompt(customerText: string): Promise<CatalogAnswer>
  /** The search tool the model may call. */
  search(query: string): Promise<CatalogAnswer>
  /** One product by the name the catalog gives it (case and accents aside), to price an order. */
  resolve(name: string): Promise<CatalogItem | null>
}

/** A product as an order line takes it: its catalog id, name, price of one sale unit right now and how much can be ordered. */
export interface CatalogItem {
  ref: string
  name: string
  unitPriceCents: number
  available: boolean
  rule: SaleRule
}

const NOTHING = 'Nothing in the catalog matches. Do not offer anything else as if it existed.'
/** translate() pairs: each accented letter and its plain one, same position (ñ reads as n, as fold() does). */
const ACCENTED = 'áéíóúüàèìòùâêîôûñ'
const PLAIN = 'aeiouuaeiouaeioun'
const money = (cents: number) => (cents / 100).toFixed(2)

/** Vortomi's inventory of the company, with prices in Bs at the company's rate. */
export function inventoryCatalog(db: Database, tenantId: string, bsPerUsd: string | null): AgentCatalog {
  const rate = bsPerUsd ? Number(bsPerUsd) : null
  return {
    bsPerUsd,
    // A small catalog goes whole before the model; a big one, only what the customer's words name.
    forPrompt: (customerText) => searchInventory(db, tenantId, customerText, rate, 'prompt'),
    search: (query) => searchInventory(db, tenantId, query, rate),
    resolve: (name) => resolveInventory(db, tenantId, name),
  }
}

/**
 * Which rate a company's own catalog is priced with in bolívares: the system's (its prices come in
 * both currencies), or the company's rate in Vortomi (every Bs price from the dollar one).
 */
export type ExternalRate = { from: 'system' } | { from: 'company'; bsPerUsd: string | null }

/**
 * The company's own system, as last read (catalog-source). Null catalog: it cannot be read and
 * nothing recent is kept.
 */
export function externalCatalog(catalog: CachedCatalog | null, rate: ExternalRate = { from: 'system' }): AgentCatalog {
  if (!catalog) {
    // Before asking, nothing is searched: the prompt says when to mention it (only if they ask about
    // products), so a greeting is answered as a greeting. The search tool says it plainly.
    const searched: CatalogAnswer = {
      products: [],
      unavailable: true,
      note: 'The product list cannot be read right now. Do not give prices or availability: tell the customer you cannot check it at this moment and offer to pass the chat to a person.',
    }
    return {
      bsPerUsd: null,
      forPrompt: () => Promise.resolve({ products: [], unavailable: true }),
      search: () => Promise.resolve(searched),
      resolve: () => Promise.resolve(null),
    }
  }
  const note = catalog.stale ? 'These prices are a few minutes old: say they may have changed slightly.' : undefined
  const bsPerUsd = rate.from === 'system' ? catalog.bsPerUsd.toFixed(2) : rate.bsPerUsd
  const companyRate = rate.from === 'company' && rate.bsPerUsd ? Number(rate.bsPerUsd) : null
  const priceBs = (p: ExternalProduct): string | undefined => {
    if (rate.from === 'system') return p.priceVes.toFixed(2)
    return companyRate ? money(Math.round(Math.round(p.priceUsd * 100) * companyRate)) : undefined
  }
  const answer = (list: ExternalProduct[]): CatalogAnswer =>
    list.length ? { products: list.map((p) => describe(p, priceBs(p))), ...(note ? { note } : {}) } : { products: [], note: NOTHING }
  return {
    bsPerUsd,
    forPrompt: (customerText) => Promise.resolve(answer(catalog.products.length <= WHOLE_CATALOG ? catalog.products : matching(catalog.products, customerText))),
    search: (query) => Promise.resolve(answer(matching(catalog.products, query))),
    resolve: (name) => {
      const p = catalog.products.find((x) => fold(x.name).trim() === fold(name).trim())
      // A company's own system says nothing about units: its products count whole.
      return Promise.resolve(p ? { ref: p.id, name: p.name, unitPriceCents: Math.round(p.priceUsd * 100), available: p.available && (p.stock === null || p.stock > 0), rule: UNIT_RULE } : null)
    },
  }
}

function describe(p: ExternalProduct, priceBs: string | undefined) {
  let availability: string
  if (p.kind === 'refill') availability = p.available ? 'can be ordered today' : 'not available today'
  else if (!p.available) availability = 'out of stock'
  else availability = p.stock !== null ? `${p.stock} in stock` : 'available'
  return {
    name: p.name,
    type: p.kind === 'refill' ? 'refill (filling the customer container)' : 'item',
    priceUsd: p.priceUsd.toFixed(2),
    priceBs,
    availability,
  }
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const isNumber = (word: string) => /^\d+$/.test(word)

/** Words that say nothing about which product: never searched («hola, ¿tienen…?» must not match «con» in a description). */
const FILLER = new Set(
  (
    'hola buenas buenos dias tardes noches tienen tiene tienes hay quiero quisiera queria necesito busco buscando venden vende ' +
    'precio precios cuanto cuanta cuantos cuantas cuesta cuestan vale valen sale salen para por con sin los las una uno unos unas ' +
    'del que como donde cual cuales mas muy favor gracias porfa ustedes usted ahi algo esta este estos estas eso esa ese son sus ' +
    'tus mis nos les tambien pero pues bien aqui alla dame deme manda mande hoy ahora todavia aun'
  ).split(' '),
)

/** Words that ask for the whole offer («dame la lista», «¿qué venden?», «el menú»): the catalog, not a product. */
const LISTING = new Set(['lista', 'catalogo', 'menu', 'carta', 'producto', 'todo', 'oferta'])

/** A plural also finds its singular: golfeados → golfeado, panes → pan, cafés → caf(e). */
const stem = (word: string) => (word.length >= 5 && word.endsWith('es') ? word.slice(0, -2) : word.length >= 4 && word.endsWith('s') ? word.slice(0, -1) : word)

/**
 * What the customer wrote, as terms to look for in the catalog: no accents, signs or filler words,
 * plurals as their stem, numbers whole. «¿Tienen golfeados?» → ["golfeado"].
 */
export function searchTerms(text: string): string[] {
  const terms = fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => isNumber(w) || (w.length >= MIN_WORD && !FILLER.has(w)))
    .map((w) => (isNumber(w) ? w : stem(w)))
    .filter((w) => isNumber(w) || w.length >= MIN_WORD)
  return [...new Set(terms)].slice(0, 6)
}

/**
 * Products whose name has any of the terms; a number ("19") matches as a whole ("19L", not "119").
 * Asking for the list («dame la lista») names no product: the first ones are given.
 */
function matching(list: ExternalProduct[], query: string): ExternalProduct[] {
  const terms = searchTerms(query)
  const words = terms.filter((w) => !LISTING.has(w))
  if (!words.length) return terms.length ? list.slice(0, WHOLE_CATALOG) : []
  return list
    .filter((p) => {
      const name = fold(p.name)
      return words.some((w) => (isNumber(w) ? new RegExp(`(^|\\D)${w}(\\D|$)`).test(name) : name.includes(w)))
    })
    .slice(0, MAX_PRODUCTS * 2)
}

/**
 * The company's active products in Vortomi's inventory, with their versions, price in $ and Bs and
 * availability. 'prompt' (before the model): a small catalog goes whole, as a company's own one
 * does, so «dame la lista» is answered; a big one, only what the words name. 'tool' (search_products):
 * what the words name, or the first ones when they ask for the list. Opens its own tenant-scoped
 * transaction, so no transaction stays open while the model thinks.
 */
export async function searchInventory(db: Database, tenantId: string, query: string, rate: number | null, use: 'prompt' | 'tool' = 'tool'): Promise<CatalogAnswer> {
  const terms = searchTerms(query)
  const named = terms.filter((w) => !LISTING.has(w))
  const asksForList = terms.length > named.length
  return withTenant(db, tenantId, async ({ tx }) => {
    if (use === 'prompt' || (asksForList && !named.length)) {
      const all = await activeProducts(tx, tenantId, undefined, WHOLE_CATALOG + 1)
      // Small: all of it. Big: only when they ask for the list, its first ones; otherwise what they name.
      if (all.length <= WHOLE_CATALOG || (asksForList && !named.length)) return describeInventory(tx, tenantId, all.slice(0, WHOLE_CATALOG), rate)
    }
    if (!named.length) return use === 'prompt' ? { products: [] } : { products: [], note: 'Ask the customer which product they mean.' }
    // Without accents on both sides: «cafe» finds «Café con leche».
    const plain = (column: AnyColumn) => sql`translate(lower(${column}), ${ACCENTED}, ${PLAIN})`
    const matches = named.flatMap((w) =>
      [products.name, products.description, productCategories.name].map((column) => sql`${plain(column)} like ${likePattern(w)}`),
    )
    return describeInventory(tx, tenantId, await activeProducts(tx, tenantId, or(...matches), MAX_PRODUCTS), rate)
  })
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]['tx']

/** The company's active products (those matching `filter`, if any), by name. */
function activeProducts(tx: Tx, tenantId: string, filter: SQL | undefined, limit: number) {
  return tx
    .select({ id: products.id, name: products.name, description: products.description, category: productCategories.name, saleUnit: products.saleUnit, minQuantity: products.minQuantity, quantityStep: products.quantityStep, stockMode: products.stockMode })
    .from(products)
    .leftJoin(productCategories, and(eq(productCategories.tenantId, products.tenantId), eq(productCategories.id, products.categoryId)))
    .where(and(eq(products.tenantId, tenantId), eq(products.active, true), filter))
    .orderBy(asc(products.name))
    .limit(limit)
}

/** Products as the model reads them: versions with price in $ and Bs, and what can be promised. */
async function describeInventory(tx: Tx, tenantId: string, found: Awaited<ReturnType<typeof activeProducts>>, rate: number | null): Promise<CatalogAnswer> {
  if (!found.length) return { products: [], note: NOTHING }
  const variants = await tx
    .select({ productId: productVariants.productId, name: productVariants.name, priceCents: productVariants.priceCents, onHand: productVariants.onHand, reserved: productVariants.reserved, available: productVariants.available })
    .from(productVariants)
    .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, found.map((p) => p.id))))
    .orderBy(asc(productVariants.priceCents))
  return {
    products: found.map((product) => ({
      name: product.name,
      category: product.category,
      description: product.description.slice(0, 300) || undefined,
      sold: unitText(product.saleUnit),
      orderable: orderableText(product),
      versions: variants
        .filter((v) => v.productId === product.id)
        .slice(0, MAX_VARIANTS)
        .map((v) => {
          const left = Math.max(0, v.onHand - v.reserved)
          let availability: string
          if (product.stockMode === 'availability') availability = v.available ? 'available today' : 'not available today'
          else availability = left > 0 ? `${left} in stock` : 'out of stock'
          return { name: v.name, priceUsd: money(v.priceCents), priceBs: rate ? money(Math.round(v.priceCents * rate)) : undefined, availability }
        }),
    })),
  }
}

/** How much can be ordered, when it is not simply "any whole number": "from 0.1, in steps of 0.05". */
function orderableText(rule: SaleRule): string | undefined {
  if (takesDecimals(rule.saleUnit)) return `quantity in ${rule.saleUnit}, from ${rule.minQuantity}, in steps of ${rule.quantityStep}`
  return rule.minQuantity > 1 ? `at least ${rule.minQuantity}` : undefined
}

/**
 * An inventory product by its full name: "Product" when it has one version, "Product Version"
 * otherwise (as the search shows them). Active products only.
 */
async function resolveInventory(db: Database, tenantId: string, name: string): Promise<CatalogItem | null> {
  const wanted = fold(name).trim()
  return withTenant(db, tenantId, async ({ tx }) => {
    const rows = await tx
      .select({ id: productVariants.id, product: products.name, version: productVariants.name, priceCents: productVariants.priceCents, saleUnit: products.saleUnit, minQuantity: products.minQuantity, quantityStep: products.quantityStep, stockMode: products.stockMode, onHand: productVariants.onHand, reserved: productVariants.reserved, available: productVariants.available })
      .from(productVariants)
      .innerJoin(products, and(eq(products.tenantId, productVariants.tenantId), eq(products.id, productVariants.productId)))
      .where(and(eq(productVariants.tenantId, tenantId), eq(products.active, true)))
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.product, (counts.get(r.product) ?? 0) + 1)
    const row = rows.find((r) => fold(`${r.product} ${r.version}`) === wanted || (counts.get(r.product) === 1 && fold(r.product) === wanted))
    if (!row) return null
    const available = row.stockMode === 'availability' ? row.available : row.onHand - row.reserved > 0
    const rule = { saleUnit: row.saleUnit, minQuantity: row.minQuantity, quantityStep: row.quantityStep }
    return { ref: row.id, name: counts.get(row.product) === 1 ? row.product : `${row.product} ${row.version}`, unitPriceCents: row.priceCents, available, rule }
  })
}

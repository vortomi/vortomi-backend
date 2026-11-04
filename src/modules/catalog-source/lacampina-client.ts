import { z } from 'zod'
import type { ExternalCatalog, ExternalProduct } from './external-catalog.ts'

// Agua Potable La Campiña's API (spec: C:\Project\Privado\especificacion-gateway-la-campina.md).
// Read only: GET /productos. Creating orders (POST /pedidos) is out of scope until agreed with them:
// their system is live and an order reaches the shop's till.

const TIMEOUT_MS = 10_000
/** 503 retries for reads, with growing waits (spec 6.2). */
const RETRY_WAITS_MS = [500, 1_000, 2_000]

const productsResponse = z.object({
  tasa_bcv: z.object({ valor: z.number().positive(), fecha: z.string() }),
  productos: z.array(
    z.object({
      id: z.string().min(1),
      nombre: z.string().min(1),
      tipo: z.enum(['recarga', 'unidad']),
      precio_usd: z.number().nonnegative(),
      precio_bs: z.number().nonnegative(),
      disponible: z.boolean(),
      existencia: z.number().int().nullable(),
    }),
  ),
})

/** Why a read failed, without anything of the request (never the key). */
export class CatalogSourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Seconds the system asked us to wait (429), when it said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'CatalogSourceError'
  }
}

export interface CatalogRead {
  catalog: ExternalCatalog
  /** What the system says is left of its per-minute budget (x-ratelimit-remaining), when it says. */
  remaining: number | null
}

/** One read of La Campiña's catalog, normalized. Never logs or returns the key. */
export async function readLaCampinaCatalog(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<CatalogRead> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/productos`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new CatalogSourceError(`Catalog source unreachable (${failureName(error)})`, null)
    }
    const remaining = numberHeader(response, 'x-ratelimit-remaining')
    if (response.status === 503 && attempt < RETRY_WAITS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAITS_MS[attempt]))
      continue
    }
    if (response.status === 429) throw new CatalogSourceError('Catalog source rate limit reached', 429, numberHeader(response, 'retry-after'))
    if (!response.ok) throw new CatalogSourceError(`Catalog source answered ${response.status}`, response.status)
    const parsed = productsResponse.safeParse(await response.json().catch(() => null))
    // A malformed answer never replaces a good catalog.
    if (!parsed.success) throw new CatalogSourceError('Catalog source answered an unexpected shape', response.status)
    return { catalog: toCatalog(parsed.data), remaining }
  }
}

/** Timeout, refused, unknown host...: the network's own code, which says where it broke. */
function failureName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? `${error.name} ${code}` : error.name
}

function toCatalog(data: z.infer<typeof productsResponse>): ExternalCatalog {
  const products: ExternalProduct[] = data.productos.map((p) => ({
    id: p.id,
    name: p.nombre,
    kind: p.tipo === 'recarga' ? 'refill' : 'unit',
    priceUsd: p.precio_usd,
    priceVes: p.precio_bs,
    available: p.disponible,
    stock: p.existencia,
  }))
  return { bsPerUsd: data.tasa_bcv.valor, rateDate: data.tasa_bcv.fecha, products }
}

function numberHeader(response: Response, name: string): number | null {
  const value = Number(response.headers.get(name))
  return Number.isFinite(value) && response.headers.has(name) ? value : null
}

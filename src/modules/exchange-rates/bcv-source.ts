import { get } from 'node:https'
import { type BcvRate, parseBcvPage } from './bcv-page.ts'
import { BCV_TRUSTED_CA } from './bcv-tls.ts'

/** Where the server reads the BCV rate; tests replace it with a fake. */
export interface BcvSource {
  /** The official rate and its fecha valor; throws BcvReadError when it cannot be read. */
  read(): Promise<BcvRate>
}

/** Why the rate could not be read, in Spanish: the panel shows it as is. */
export class BcvReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BcvReadError'
  }
}

export const BCV_NO_ANSWER = 'la página del BCV no respondió.'
const BCV_CHANGED = 'la página del BCV cambió y no encontramos la tasa.'

const BCV_URL = 'https://www.bcv.org.ve/'
/**
 * A public mirror of the same official rate, used only when bcv.org.ve does not answer (it may
 * refuse connections from outside Venezuela, where the server runs).
 */
const MIRROR_URL = 'https://ve.dolarapi.com/v1/dolares/oficial'
const TIMEOUT_MS = 15_000
/** The home page is about 100 KB; anything far larger is not the page we parse. */
const MAX_PAGE_BYTES = 2_000_000

/** The error and its cause ("fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE"), for the logs. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined
  const code = (error as { code?: unknown }).code ?? cause?.code ?? cause?.message
  return typeof code === 'string' && !error.message.includes(code) ? `${error.message}: ${code}` : error.message
}

/**
 * The BCV home page over https with the intermediate it forgets to send (see bcv-tls.ts). fetch()
 * takes no CA list without undici, so this one request uses node:https.
 */
function getBcvPage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(BCV_URL, { ca: [...BCV_TRUSTED_CA], timeout: TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new BcvReadError(BCV_NO_ANSWER))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PAGE_BYTES) {
          request.destroy(new BcvReadError(BCV_CHANGED))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** bcv.org.ve first, then the mirror. */
export class HttpBcvSource implements BcvSource {
  constructor(private readonly log: { warn(message: string): void }) {}

  async read(): Promise<BcvRate> {
    try {
      return await this.fromBcv()
    } catch (error) {
      this.log.warn(`bcv.org.ve: ${describe(error)}`)
      try {
        return await this.fromMirror()
      } catch (mirrorError) {
        this.log.warn(`mirror: ${describe(mirrorError)}`)
        throw error instanceof BcvReadError ? error : new BcvReadError(BCV_NO_ANSWER)
      }
    }
  }

  private async fromBcv(): Promise<BcvRate> {
    const rate = parseBcvPage(await getBcvPage())
    if (!rate) throw new BcvReadError(BCV_CHANGED)
    return rate
  }

  private async fromMirror(): Promise<BcvRate> {
    const response = await fetch(MIRROR_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const body = (await response.json()) as { promedio?: unknown; fechaActualizacion?: unknown }
    const rate = typeof body.promedio === 'number' ? body.promedio : NaN
    const date = typeof body.fechaActualizacion === 'string' ? body.fechaActualizacion.slice(0, 10) : ''
    if (!(rate > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('unexpected answer')
    return { bsPerUsd: rate.toFixed(8), effectiveDate: date }
  }
}

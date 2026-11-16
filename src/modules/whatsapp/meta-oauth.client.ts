import { z } from 'zod'
import { WhatsAppApiError } from './cloud-api.client.ts'

/** What Meta says about a token: whose it is, until when, and which WhatsApp accounts it reaches. */
export interface TokenGrant {
  appId: string
  valid: boolean
  /** null: it does not expire. */
  expiresAt: Date | null
  /** WhatsApp Business Accounts the company granted to the app. */
  wabaIds: string[]
}

/** Port for Embedded Signup: the code the panel got becomes the company's token. Tests fake it. */
export interface BusinessTokenExchange {
  /** The app the tokens must belong to. */
  readonly appId: string
  exchangeCode(code: string): Promise<string>
  inspect(accessToken: string): Promise<TokenGrant>
}

const tokenResponseSchema = z.object({ access_token: z.string().min(20) })
const debugResponseSchema = z.object({
  data: z.object({
    app_id: z.string(),
    is_valid: z.boolean(),
    // 0 = never.
    expires_at: z.number().int().nonnegative().default(0),
    granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() })).default([]),
  }),
})

const WABA_SCOPES = new Set(['whatsapp_business_management', 'whatsapp_business_messaging'])
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The two Graph calls of the app itself (not of a company's number): exchanging the signup code and
 * reading a token's grant. They carry the app secret, so nothing about the request is ever put in an
 * error: only Meta's status and code.
 */
export class MetaOAuthClient implements BusinessTokenExchange {
  constructor(
    private readonly apiVersion: string,
    readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** The code lives 30 seconds and works once. */
  async exchangeCode(code: string): Promise<string> {
    const query = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, code })
    const parsed = tokenResponseSchema.safeParse(await this.get(`oauth/access_token?${query.toString()}`))
    if (!parsed.success) throw new WhatsAppApiError('Meta returned no access token', null, null)
    return parsed.data.access_token
  }

  async inspect(accessToken: string): Promise<TokenGrant> {
    const query = new URLSearchParams({ input_token: accessToken, access_token: `${this.appId}|${this.appSecret}` })
    const parsed = debugResponseSchema.safeParse(await this.get(`debug_token?${query.toString()}`))
    if (!parsed.success) throw new WhatsAppApiError('Meta returned no token details', null, null)
    const { app_id, is_valid, expires_at, granular_scopes } = parsed.data.data
    const wabaIds = new Set(granular_scopes.filter((s) => WABA_SCOPES.has(s.scope)).flatMap((s) => s.target_ids ?? []))
    return { appId: app_id, valid: is_valid, expiresAt: expires_at > 0 ? new Date(expires_at * 1000) : null, wabaIds: [...wabaIds] }
  }

  private async get(pathAndQuery: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchFn(`https://graph.facebook.com/${this.apiVersion}/${pathAndQuery}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      throw new WhatsAppApiError(`Meta request failed (${error instanceof Error ? error.name : 'unknown'})`, null, null)
    }
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = z.object({ error: z.object({ code: z.number() }) }).safeParse(json)
      throw new WhatsAppApiError(`Meta rejected the request (${response.status})`, response.status, code.success ? code.data.error.code : null)
    }
    return json
  }
}

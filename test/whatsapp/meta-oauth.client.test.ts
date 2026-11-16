import { describe, expect, it, vi } from 'vitest'
import { WhatsAppApiError } from '../../src/modules/whatsapp/cloud-api.client.ts'
import { MetaOAuthClient } from '../../src/modules/whatsapp/meta-oauth.client.ts'

const APP_ID = '1167128472338629'
const SECRET = 'signup-app-secret-0123456789'
const TOKEN = 'EAAG-business-token-0123456789abcdef'

function clientReturning(status: number, body: unknown) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  return { client: new MetaOAuthClient('v27.0', APP_ID, SECRET, fetchFn), fetchFn }
}

describe('MetaOAuthClient.exchangeCode', () => {
  it('turns the signup code into the company\'s token', async () => {
    const { client, fetchFn } = clientReturning(200, { access_token: TOKEN, token_type: 'bearer' })
    await expect(client.exchangeCode('AQD-code')).resolves.toBe(TOKEN)
    const url = new URL(fetchFn.mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://graph.facebook.com/v27.0/oauth/access_token')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: APP_ID, client_secret: SECRET, code: 'AQD-code' })
  })

  it('a refused code says only Meta\'s status and code: never the secret or the code', async () => {
    const { client } = clientReturning(400, { error: { message: `Invalid code AQD-code for ${SECRET}`, code: 100 } })
    const error = await client.exchangeCode('AQD-code').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WhatsAppApiError)
    expect(error).toMatchObject({ httpStatus: 400, metaCode: 100 })
    expect((error as Error).message).not.toContain(SECRET)
    expect((error as Error).message).not.toContain('AQD-code')
  })
})

describe('MetaOAuthClient.inspect', () => {
  it('reads whose token it is, until when, and the WhatsApp accounts it was granted', async () => {
    const { client, fetchFn } = clientReturning(200, {
      data: {
        app_id: APP_ID,
        is_valid: true,
        expires_at: 1_800_000_000,
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: ['300000000000011'] },
          { scope: 'whatsapp_business_messaging', target_ids: ['300000000000011'] },
          { scope: 'business_management', target_ids: ['999'] },
        ],
      },
    })
    await expect(client.inspect(TOKEN)).resolves.toEqual({ appId: APP_ID, valid: true, expiresAt: new Date(1_800_000_000_000), wabaIds: ['300000000000011'] })
    const url = new URL(fetchFn.mock.calls[0]![0])
    expect(url.pathname).toBe('/v27.0/debug_token')
    expect(url.searchParams.get('access_token')).toBe(`${APP_ID}|${SECRET}`)
  })

  it('a token that never expires has no date', async () => {
    const { client } = clientReturning(200, { data: { app_id: APP_ID, is_valid: true, expires_at: 0 } })
    await expect(client.inspect(TOKEN)).resolves.toMatchObject({ expiresAt: null, wabaIds: [] })
  })
})

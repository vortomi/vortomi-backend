import { describe, expect, it, vi } from 'vitest'
import { CloudApiClient, WhatsAppApiError } from '../../src/modules/whatsapp/cloud-api.client.ts'

const TOKEN = 'EAAG-secret-access-token-value'
const MESSAGE = { phoneNumberId: '123', accessToken: TOKEN, to: '584121234567', body: 'Hola' }

function clientReturning(status: number, body: unknown) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  const client = new CloudApiClient('v25.0', fetchFn)
  return { client, fetchFn }
}

describe('CloudApiClient.sendText', () => {
  it('posts a text message and returns the WhatsApp message id', async () => {
    const { client, fetchFn } = clientReturning(200, { messages: [{ id: 'wamid.ok' }] })

    await expect(client.sendText(MESSAGE)).resolves.toEqual({ waMessageId: 'wamid.ok' })

    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://graph.facebook.com/v25.0/123/messages')
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
    expect(JSON.parse(init?.body as string)).toMatchObject({ to: '584121234567', type: 'text', text: { body: 'Hola' } })
  })

  it("surfaces Meta's error without leaking the token", async () => {
    const { client } = clientReturning(400, { error: { message: 'Invalid parameter', code: 100 } })

    const error = await client.sendText(MESSAGE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WhatsAppApiError)
    expect(error).toMatchObject({ httpStatus: 400, metaCode: 100 })
    expect((error as Error).message).toContain('Invalid parameter')
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('fails when Meta answers 200 without a message id', async () => {
    const { client } = clientReturning(200, { messages: [] })
    await expect(client.sendText(MESSAGE)).rejects.toBeInstanceOf(WhatsAppApiError)
  })

  it('wraps network failures', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const client = new CloudApiClient('v25.0', fetchFn)
    await expect(client.sendText(MESSAGE)).rejects.toThrow('Cloud API request failed (TypeError)')
  })
})

describe('CloudApiClient.sendImage', () => {
  const IMAGE = { ...MESSAGE, image: { bytes: Buffer.from('png-bytes'), mimeType: 'image/png' as const, filename: 'recibo.png' }, caption: 'Tu recibo' }

  it('uploads the file to the number, then sends a message pointing to it', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'media-77' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.img' }] }), { status: 200 }))
    const client = new CloudApiClient('v25.0', fetchFn)

    await expect(client.sendImage(IMAGE)).resolves.toEqual({ waMessageId: 'wamid.img' })

    const [uploadUrl, upload] = fetchFn.mock.calls[0]!
    expect(uploadUrl).toBe('https://graph.facebook.com/v25.0/123/media')
    const form = upload?.body as FormData
    expect(form.get('messaging_product')).toBe('whatsapp')
    expect(form.get('type')).toBe('image/png')
    expect((form.get('file') as File).name).toBe('recibo.png')
    // fetch sets the multipart boundary itself: no JSON content type on the upload.
    expect(upload?.headers).not.toHaveProperty('Content-Type')
    const [, send] = fetchFn.mock.calls[1]!
    expect(JSON.parse(send?.body as string)).toMatchObject({ to: '584121234567', type: 'image', image: { id: 'media-77', caption: 'Tu recibo' } })
  })

  it('sends nothing when Meta does not take the file', async () => {
    const { client, fetchFn } = clientReturning(400, { error: { message: 'Invalid file', code: 131053 } })
    await expect(client.sendImage(IMAGE)).rejects.toMatchObject({ metaCode: 131053 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

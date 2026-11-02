import { z } from 'zod'

interface Credentials {
  accessToken: string
}

export interface TextMessage extends Credentials {
  phoneNumberId: string
  /** Customer WhatsApp id (digits). */
  to: string
  body: string
}

export interface TemplateMessage extends Credentials {
  phoneNumberId: string
  to: string
  name: string
  language: string
  /** Values for {{1}}, {{2}}... of the body, in order. */
  bodyParameters: string[]
}

/** A picture we made (a sale receipt): uploaded to Meta, then sent with its caption. */
export interface ImageMessage extends Credentials {
  phoneNumberId: string
  to: string
  image: { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg'; filename: string }
  caption: string
}

export interface TemplateSubmission extends Credentials {
  wabaId: string
  name: string
  language: string
  category: 'utility' | 'marketing' | 'authentication'
  body: string
  bodyExample: string[]
}

/** Port the domain sends through. Tests replace it with a fake. */
export interface WhatsAppSender {
  sendText(message: TextMessage): Promise<{ waMessageId: string }>
  sendTemplate(message: TemplateMessage): Promise<{ waMessageId: string }>
  sendImage(message: ImageMessage): Promise<{ waMessageId: string }>
}

/** A file a customer sent (image, document), downloaded from Meta. */
export interface DownloadedMedia {
  bytes: Buffer
  mimeType: string
}

/** Downloads the files customers send, by their WhatsApp media id. */
export interface MediaDownloader {
  downloadMedia(mediaId: string, accessToken: string): Promise<DownloadedMedia>
}

/** Marks the customer's message read and shows "escribiendo…" to them (up to 25 s or until we answer). */
export interface TypingIndicator {
  showTyping(message: { phoneNumberId: string; accessToken: string; waMessageId: string }): Promise<void>
}

/** A number of a WhatsApp Business Account, as Meta describes it. */
export interface WabaNumber {
  phoneNumberId: string
  displayNumber: string
  verifiedName: string
  /** APPROVED, PENDING_REVIEW, DECLINED... Meta's review of the display name. */
  nameStatus: string
}

/** Port for connecting a company's account: read its numbers and receive its events. */
export interface WabaDirectory {
  listNumbers(wabaId: string, accessToken: string): Promise<WabaNumber[]>
  /** Subscribes our app to the account's webhooks, so its messages reach us. */
  subscribeApp(wabaId: string, accessToken: string): Promise<void>
}

/** Port for managing templates in a WhatsApp Business Account. */
export interface TemplateRegistry {
  submitTemplate(submission: TemplateSubmission): Promise<{ metaTemplateId: string; status: string }>
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly metaCode: number | null,
  ) {
    super(message)
    this.name = 'WhatsAppApiError'
  }
}

const sendResponseSchema = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) })
const submitResponseSchema = z.object({ id: z.string().min(1), status: z.string() })
const errorResponseSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.number().optional() }),
})

const numbersResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().regex(/^\d+$/),
      display_phone_number: z.string(),
      verified_name: z.string().default(''),
      name_status: z.string().default(''),
    }),
  ),
})

/** The only Graph paths this client calls. Ids are digits only: nothing can redirect a call elsewhere. */
const ALLOWED_PATHS = /^\d+(\/(messages|media|message_templates|subscribed_apps|phone_numbers\?fields=id,display_phone_number,verified_name,name_status))?$/

/** Where Meta serves media files from: nothing else is ever fetched with the number's token. */
const MEDIA_HOSTS = /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/
/** Larger files are not kept (a payment receipt is a few hundred KB). */
const MAX_MEDIA_BYTES = 5 * 1024 * 1024
const mediaResponseSchema = z.object({ url: z.url(), mime_type: z.string().min(1) })
const uploadResponseSchema = z.object({ id: z.string().min(1) })

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Thin transport over the Graph API (reused from project-1). Multi-company: the
 * number or account and its token come with every call. No business rules here.
 */
export class CloudApiClient implements WhatsAppSender, TypingIndicator, MediaDownloader, TemplateRegistry, WabaDirectory {
  constructor(
    private readonly apiVersion: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  sendText({ phoneNumberId, accessToken, to, body }: TextMessage): Promise<{ waMessageId: string }> {
    return this.sendMessage(phoneNumberId, accessToken, { to, type: 'text', text: { preview_url: false, body } })
  }

  sendTemplate({ phoneNumberId, accessToken, to, name, language, bodyParameters }: TemplateMessage): Promise<{ waMessageId: string }> {
    const components = bodyParameters.length
      ? [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }]
      : []
    return this.sendMessage(phoneNumberId, accessToken, { to, type: 'template', template: { name, language: { code: language }, components } })
  }

  /** Meta takes the file first (POST /media) and the message then points to it by id. */
  async sendImage({ phoneNumberId, accessToken, to, image, caption }: ImageMessage): Promise<{ waMessageId: string }> {
    if (!image.bytes.length || image.bytes.length > MAX_MEDIA_BYTES) throw new WhatsAppApiError('Image empty or too large', null, null)
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', image.mimeType)
    form.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.filename)
    const parsed = uploadResponseSchema.safeParse(await this.request('POST', `${phoneNumberId}/media`, accessToken, form))
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no media id', null, null)
    return this.sendMessage(phoneNumberId, accessToken, { to, type: 'image', image: { id: parsed.data.id, caption } })
  }

  async showTyping({ phoneNumberId, accessToken, waMessageId }: { phoneNumberId: string; accessToken: string; waMessageId: string }): Promise<void> {
    await this.post(`${phoneNumberId}/messages`, accessToken, { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId, typing_indicator: { type: 'text' } })
  }

  /** Meta gives a short-lived URL for the media id; the file is fetched from it with the same token. */
  async downloadMedia(mediaId: string, accessToken: string): Promise<DownloadedMedia> {
    const parsed = mediaResponseSchema.safeParse(await this.request('GET', mediaId, accessToken))
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no media url', null, null)
    const url = new URL(parsed.data.url)
    if (url.protocol !== 'https:' || !MEDIA_HOSTS.test(url.hostname)) throw new WhatsAppApiError('Unexpected media host', null, null)
    let response: Response
    try {
      response = await this.fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) })
    } catch (error) {
      throw new WhatsAppApiError(`Media download failed (${error instanceof Error ? error.name : 'unknown'})`, null, null)
    }
    if (!response.ok) throw new WhatsAppApiError(`Media download answered ${response.status}`, response.status, null)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new WhatsAppApiError('Media file empty or too large', null, null)
    return { bytes, mimeType: parsed.data.mime_type }
  }

  async submitTemplate(submission: TemplateSubmission): Promise<{ metaTemplateId: string; status: string }> {
    const { wabaId, accessToken, name, language, category, body, bodyExample } = submission
    const json = await this.post(`${wabaId}/message_templates`, accessToken, {
      name,
      language,
      category: category.toUpperCase(),
      components: [{ type: 'BODY', text: body, ...(bodyExample.length ? { example: { body_text: [bodyExample] } } : {}) }],
    })
    const parsed = submitResponseSchema.safeParse(json)
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no template id', null, null)
    return { metaTemplateId: parsed.data.id, status: parsed.data.status }
  }

  async listNumbers(wabaId: string, accessToken: string): Promise<WabaNumber[]> {
    const json = await this.request('GET', `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,name_status`, accessToken)
    const parsed = numbersResponseSchema.safeParse(json)
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no phone numbers', null, null)
    return parsed.data.data.map((n) => ({ phoneNumberId: n.id, displayNumber: n.display_phone_number, verifiedName: n.verified_name, nameStatus: n.name_status }))
  }

  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    await this.request('POST', `${wabaId}/subscribed_apps`, accessToken, {})
  }

  private async sendMessage(phoneNumberId: string, accessToken: string, message: object): Promise<{ waMessageId: string }> {
    const json = await this.post(`${phoneNumberId}/messages`, accessToken, { messaging_product: 'whatsapp', recipient_type: 'individual', ...message })
    const parsed = sendResponseSchema.safeParse(json)
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no message id', null, null)
    // min(1) above guarantees the first element exists.
    return { waMessageId: parsed.data.messages[0]!.id }
  }

  private post(path: string, accessToken: string, payload: object): Promise<unknown> {
    return this.request('POST', path, accessToken, payload)
  }

  /** A plain object goes as JSON; a form (a file upload) as multipart, its boundary set by fetch. */
  private async request(method: 'GET' | 'POST', path: string, accessToken: string, payload?: object | FormData): Promise<unknown> {
    if (!ALLOWED_PATHS.test(path)) throw new WhatsAppApiError('Invalid Graph API path', null, null)
    const url = `https://graph.facebook.com/${this.apiVersion}/${path}`

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, ...(payload && !(payload instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: payload instanceof FormData ? payload : JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown'
      throw new WhatsAppApiError(`Cloud API request failed (${reason})`, null, null)
    }

    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      // Only Meta's message and code: never the token, headers or request body.
      const detail = errorResponseSchema.safeParse(json)
      const metaError = detail.success ? detail.data.error : null
      throw new WhatsAppApiError(
        `Cloud API rejected the request (${response.status}): ${metaError?.message ?? 'no detail'}`,
        response.status,
        metaError?.code ?? null,
      )
    }
    return json
  }
}

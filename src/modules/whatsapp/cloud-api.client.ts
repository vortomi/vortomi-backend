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
  /** Files over `maxBytes` (5 MB unless said) are refused with MediaTooLargeError, before downloading when Meta says the size. */
  downloadMedia(mediaId: string, accessToken: string, maxBytes?: number): Promise<DownloadedMedia>
}

/** The file is larger than the caller keeps: it stays on the phone. */
export class MediaTooLargeError extends Error {
  constructor(readonly sizeBytes: number | null) {
    super('Media file too large')
    this.name = 'MediaTooLargeError'
  }
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

/** One number as Meta describes it, with whether it also lives on the WhatsApp Business app. */
export interface NumberDetails {
  displayNumber: string
  verifiedName: string
  /** Coexistence: the owner keeps using it on the WhatsApp Business app. */
  onBusinessApp: boolean
}

/** What the WhatsApp Business app shares once, right after coexistence onboarding (within 24 h). */
export type AppDataSync = 'smb_app_state_sync' | 'history'

/** Port for connecting a company's account: read its numbers and receive its events. */
export interface WabaDirectory {
  listNumbers(wabaId: string, accessToken: string): Promise<WabaNumber[]>
  /** Meta's business verification of the portfolio that owns the account (verified, pending, not_verified...); null if Meta does not say. */
  businessVerification(wabaId: string, accessToken: string): Promise<string | null>
  /** Subscribes our app to the account's webhooks, so its messages reach us. */
  subscribeApp(wabaId: string, accessToken: string): Promise<void>
  numberDetails(phoneNumberId: string, accessToken: string): Promise<NumberDetails>
  /** Puts a new number on Cloud API with its two-step verification PIN (6 digits). */
  registerNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<void>
  /** Asks Meta to send, by webhook, the contacts or the chat history of the owner's app. */
  requestAppDataSync(phoneNumberId: string, accessToken: string, kind: AppDataSync): Promise<void>
}

/** A Meta app, by its public id. */
export interface MetaApp {
  id: string
  name: string
}

/** Port for watching who receives a number's messages (mockup web-31). */
export interface SubscriptionReader {
  /** The app the token was issued for: the one its calls act as. */
  tokenApp(accessToken: string): Promise<MetaApp>
  /** Every app Meta delivers the account's webhooks to (ours and anyone else's). */
  subscribedApps(wabaId: string, accessToken: string): Promise<MetaApp[]>
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

const numberDetailsSchema = z.object({
  display_phone_number: z.string(),
  verified_name: z.string().default(''),
  is_on_biz_app: z.boolean().default(false),
})

const verificationSchema = z.object({ business_verification_status: z.string().optional() })

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

const appSchema = z.object({ id: z.string().regex(/^\d+$/), name: z.string().default('') })
const subscribedAppsSchema = z.object({ data: z.array(z.object({ whatsapp_business_api_data: appSchema })) })

/**
 * The only Graph paths this client calls. Ids are digits only: nothing can redirect a call elsewhere.
 * «app» is the app the token itself belongs to.
 */
const ALLOWED_PATHS =
  /^(app\?fields=id,name|\d+(\?fields=display_phone_number,verified_name,is_on_biz_app|\?fields=business_verification_status|\/(messages|media|message_templates|subscribed_apps|register|smb_app_data|phone_numbers\?fields=id,display_phone_number,verified_name,name_status))?)$/

/** Where Meta serves media files from: nothing else is ever fetched with the number's token. */
const MEDIA_HOSTS = /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/
/** Larger files are not kept (a payment receipt is a few hundred KB). */
const MAX_MEDIA_BYTES = 5 * 1024 * 1024
const mediaResponseSchema = z.object({ url: z.url(), mime_type: z.string().min(1), file_size: z.coerce.number().int().nonnegative().optional() })
/** Meta's own ceiling for any media message (Cloud API docs): nothing larger is ever read. */
const MEDIA_HARD_LIMIT_BYTES = 100 * 1024 * 1024
const uploadResponseSchema = z.object({ id: z.string().min(1) })

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Thin transport over the Graph API (reused from project-1). Multi-company: the
 * number or account and its token come with every call. No business rules here.
 */
export class CloudApiClient implements WhatsAppSender, TypingIndicator, MediaDownloader, TemplateRegistry, WabaDirectory, SubscriptionReader {
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
  async downloadMedia(mediaId: string, accessToken: string, maxBytes = MAX_MEDIA_BYTES): Promise<DownloadedMedia> {
    const limit = Math.min(maxBytes, MEDIA_HARD_LIMIT_BYTES)
    const parsed = mediaResponseSchema.safeParse(await this.request('GET', mediaId, accessToken))
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no media url', null, null)
    // Meta says the size first: a file over the limit is never downloaded.
    if (parsed.data.file_size !== undefined && parsed.data.file_size > limit) throw new MediaTooLargeError(parsed.data.file_size)
    const url = new URL(parsed.data.url)
    if (url.protocol !== 'https:' || !MEDIA_HOSTS.test(url.hostname)) throw new WhatsAppApiError('Unexpected media host', null, null)
    let response: Response
    try {
      response = await this.fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) })
    } catch (error) {
      throw new WhatsAppApiError(`Media download failed (${error instanceof Error ? error.name : 'unknown'})`, null, null)
    }
    if (!response.ok) throw new WhatsAppApiError(`Media download answered ${response.status}`, response.status, null)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > limit) throw new MediaTooLargeError(declared)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) throw new MediaTooLargeError(bytes.length)
    if (!bytes.length) throw new WhatsAppApiError('Media file empty', null, null)
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

  async businessVerification(wabaId: string, accessToken: string): Promise<string | null> {
    const parsed = verificationSchema.safeParse(await this.request('GET', `${wabaId}?fields=business_verification_status`, accessToken))
    return parsed.success ? (parsed.data.business_verification_status ?? null) : null
  }

  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    await this.request('POST', `${wabaId}/subscribed_apps`, accessToken, {})
  }

  async tokenApp(accessToken: string): Promise<MetaApp> {
    const parsed = appSchema.safeParse(await this.request('GET', 'app?fields=id,name', accessToken))
    if (!parsed.success) throw new WhatsAppApiError('Graph API returned no app', null, null)
    return parsed.data
  }

  async subscribedApps(wabaId: string, accessToken: string): Promise<MetaApp[]> {
    const parsed = subscribedAppsSchema.safeParse(await this.request('GET', `${wabaId}/subscribed_apps`, accessToken))
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no subscribed apps', null, null)
    return parsed.data.data.map((entry) => entry.whatsapp_business_api_data)
  }

  async numberDetails(phoneNumberId: string, accessToken: string): Promise<NumberDetails> {
    const json = await this.request('GET', `${phoneNumberId}?fields=display_phone_number,verified_name,is_on_biz_app`, accessToken)
    const parsed = numberDetailsSchema.safeParse(json)
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no number details', null, null)
    return { displayNumber: parsed.data.display_phone_number, verifiedName: parsed.data.verified_name, onBusinessApp: parsed.data.is_on_biz_app }
  }

  async registerNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new WhatsAppApiError('The PIN must be 6 digits', null, null)
    await this.post(`${phoneNumberId}/register`, accessToken, { messaging_product: 'whatsapp', pin })
  }

  async requestAppDataSync(phoneNumberId: string, accessToken: string, kind: AppDataSync): Promise<void> {
    await this.post(`${phoneNumberId}/smb_app_data`, accessToken, { messaging_product: 'whatsapp', sync_type: kind })
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

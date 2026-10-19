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

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Thin transport over the Graph API (reused from project-1). Multi-company: the
 * number or account and its token come with every call. No business rules here.
 */
export class CloudApiClient implements WhatsAppSender, TemplateRegistry {
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

  private async sendMessage(phoneNumberId: string, accessToken: string, message: object): Promise<{ waMessageId: string }> {
    const json = await this.post(`${phoneNumberId}/messages`, accessToken, { messaging_product: 'whatsapp', recipient_type: 'individual', ...message })
    const parsed = sendResponseSchema.safeParse(json)
    if (!parsed.success) throw new WhatsAppApiError('Cloud API returned no message id', null, null)
    // min(1) above guarantees the first element exists.
    return { waMessageId: parsed.data.messages[0]!.id }
  }

  private async post(path: string, accessToken: string, payload: object): Promise<unknown> {
    // Ids are digits only; anything else could redirect the call to another Graph path.
    if (!/^\d+\/(messages|message_templates)$/.test(path)) throw new WhatsAppApiError('Invalid Graph API path', null, null)
    const url = `https://graph.facebook.com/${this.apiVersion}/${path}`

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

import { createHmac } from 'node:crypto'

export const APP_SECRET = 'test-app-secret-0123456789'
export const VERIFY_TOKEN = 'test-verify-token-0123456789abcdef'
export const CUSTOMER_WA_ID = '584121234567'

/** Numbers of the two test companies, and one nobody owns. */
export const PHONE_A = '100000000000001'
export const PHONE_B = '100000000000002'
export const PHONE_UNKNOWN = '199999999999999'

export const unix = (date: Date): string => String(Math.floor(date.getTime() / 1000))

export function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

interface ValueParts {
  contacts?: unknown[]
  messages?: unknown[]
  statuses?: unknown[]
}

/** One change of a webhook, addressed to one business number. */
export function change(phoneNumberId: string | null, parts: ValueParts): object {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      ...(phoneNumberId ? { metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId } } : {}),
      ...parts,
    },
  }
}

export function webhook(...changes: object[]): object {
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba-id', changes }] }
}

export function textChange(phoneNumberId: string, id: string, body: string, from = CUSTOMER_WA_ID, at = new Date()): object {
  return change(phoneNumberId, {
    contacts: [{ wa_id: from, profile: { name: 'María Pérez' } }],
    messages: [{ id, from, timestamp: unix(at), type: 'text', text: { body } }],
  })
}

export function statusChange(phoneNumberId: string, id: string, status: string, at = new Date()): object {
  return change(phoneNumberId, { statuses: [{ id, status, timestamp: unix(at), recipient_id: CUSTOMER_WA_ID }] })
}

/** A message_template_status_update webhook, shaped like Meta's reference example. */
export function templateStatusWebhook(wabaId: string, value: object): object {
  return { object: 'whatsapp_business_account', entry: [{ id: wabaId, time: unix(new Date()), changes: [{ field: 'message_template_status_update', value }] }] }
}

import { DELIVERY_STATUSES, type DeliveryStatus, type MessageType } from '../../db/schema/enums.ts'
import {
  type InboundMessageEvent,
  type ParseResult,
  type StatusUpdateEvent,
} from './events.ts'
import { contactSchema, envelopeSchema, messageSchema, statusSchema, templateStatusSchema, type RawMessage } from './payload.schema.ts'

const fromUnixSeconds = (value: string): Date => new Date(Number(value) * 1000)

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const
type MediaType = (typeof MEDIA_TYPES)[number]
const isMediaType = (type: string): type is MediaType => (MEDIA_TYPES as readonly string[]).includes(type)
const isDeliveryStatus = (status: string): status is DeliveryStatus =>
  (DELIVERY_STATUSES as readonly string[]).includes(status)

/** Maps Meta's message variants onto one flat shape. Unknown types are kept as "unsupported". */
function toContent(message: RawMessage): Pick<InboundMessageEvent, 'type' | 'body' | 'replyId' | 'waMediaId'> {
  const empty = { body: null, replyId: null, waMediaId: null }

  if (message.type === 'text' && message.text) return { ...empty, type: 'text', body: message.text.body }

  if (isMediaType(message.type)) {
    const media = message[message.type]
    if (media) return { ...empty, type: message.type, body: media.caption ?? null, waMediaId: media.id }
  }

  if (message.type === 'interactive' && message.interactive) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply
    if (reply) return { ...empty, type: 'interactive', body: reply.title, replyId: reply.id }
  }

  // Quick-reply button tapped on a template message.
  if (message.type === 'button' && message.button) {
    return { ...empty, type: 'button', body: message.button.text, replyId: message.button.payload ?? null }
  }

  if (message.type === 'reaction') return { ...empty, type: 'reaction', body: message.reaction?.emoji ?? null }

  if (message.type === 'location' && message.location) {
    const { name, address, latitude, longitude } = message.location
    return { ...empty, type: 'location', body: [name, address].filter(Boolean).join(', ') || `${latitude},${longitude}` }
  }

  const passthrough: readonly MessageType[] = ['contacts']
  const type = passthrough.find((t) => t === message.type) ?? 'unsupported'
  return { ...empty, type }
}

/**
 * Turns one verified webhook payload into events, each tagged with the business
 * number it arrived on. Which company that number belongs to is decided later, by
 * the event router: the parser never assumes it.
 */
export function parseWebhookPayload(payload: unknown): ParseResult {
  const result: ParseResult = { events: [], skipped: [] }

  const envelope = envelopeSchema.safeParse(payload)
  if (!envelope.success) {
    result.skipped.push('invalid_envelope')
    return result
  }

  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      if (change.field === 'message_template_status_update') {
        const template = templateStatusSchema.safeParse(change.value)
        // Digits only: the WABA id becomes a routing key and a database lookup.
        if (!entry.id || !/^\d+$/.test(entry.id) || !template.success) {
          result.skipped.push('invalid_template_status')
          continue
        }
        const reason = template.data.rejection_info?.reason ?? template.data.reason ?? null
        result.events.push({
          kind: 'template_status',
          wabaId: entry.id,
          metaTemplateId: template.data.message_template_id,
          event: template.data.event.toUpperCase(),
          reason: reason && reason !== 'NONE' ? reason : null,
        })
        continue
      }
      if (change.field !== 'messages') continue
      const { metadata, contacts = [], messages = [], statuses = [] } = change.value

      const phoneNumberId = metadata?.phone_number_id
      if (!phoneNumberId) {
        result.skipped.push('missing_phone_number_id')
        continue
      }

      const nameByWaId = new Map<string, string>()
      for (const raw of contacts) {
        const contact = contactSchema.safeParse(raw)
        if (contact.success && contact.data.profile?.name) nameByWaId.set(contact.data.wa_id, contact.data.profile.name)
      }

      for (const raw of messages) {
        const message = messageSchema.safeParse(raw)
        if (!message.success) {
          result.skipped.push('invalid_message')
          continue
        }
        result.events.push({
          kind: 'inbound_message',
          phoneNumberId,
          waMessageId: message.data.id,
          from: message.data.from,
          profileName: nameByWaId.get(message.data.from) ?? null,
          timestamp: fromUnixSeconds(message.data.timestamp),
          ...toContent(message.data),
        })
      }

      for (const raw of statuses) {
        const status = statusSchema.safeParse(raw)
        if (!status.success) {
          result.skipped.push('invalid_status')
          continue
        }
        if (!isDeliveryStatus(status.data.status)) {
          result.skipped.push('unknown_status')
          continue
        }
        const { pricing, errors } = status.data
        const event: StatusUpdateEvent = {
          kind: 'status_update',
          phoneNumberId,
          waMessageId: status.data.id,
          status: status.data.status,
          timestamp: fromUnixSeconds(status.data.timestamp),
          pricing: pricing ? { billable: pricing.billable ?? null, category: pricing.category ?? null } : null,
          errorText: errors?.[0] ? `${errors[0].code ?? 'unknown'}: ${errors[0].title ?? 'no title'}` : null,
        }
        result.events.push(event)
      }
    }
  }

  return result
}

import type { ParseResult, StatusUpdateEvent } from './events.ts'
import { fromUnixSeconds, isDeliveryStatus, toContent } from './message-content.ts'
import { parseContactSync, parseEchoes, parseHistory } from './owner-app-parser.ts'
import { contactSchema, envelopeSchema, messageSchema, statusSchema, templateStatusSchema } from './payload.schema.ts'

/** Fields about a number (routed by its phone_number_id); others are ignored. */
const NUMBER_FIELDS = new Set(['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync'])

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
      if (!NUMBER_FIELDS.has(change.field)) continue
      const { metadata, contacts = [], messages = [], statuses = [] } = change.value

      const phoneNumberId = metadata?.phone_number_id
      if (!phoneNumberId) {
        result.skipped.push('missing_phone_number_id')
        continue
      }

      // Coexistence numbers: what the owner does on the WhatsApp Business app.
      if (change.field === 'smb_message_echoes') {
        parseEchoes(Array.isArray(change.value['message_echoes']) ? change.value['message_echoes'] : [], phoneNumberId, result)
        continue
      }
      if (change.field === 'history') {
        parseHistory(change.value['history'], phoneNumberId, result)
        continue
      }
      if (change.field === 'smb_app_state_sync') {
        parseContactSync(change.value['state_sync'], phoneNumberId, result)
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

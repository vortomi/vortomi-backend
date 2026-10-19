import type { DeliveryStatus, MessageType } from '../../db/schema/enums.ts'

/**
 * Provider-agnostic events produced by the webhook parser. Nothing past the
 * parser knows the shape of Meta's payload.
 */
interface EventBase {
  /** Business number the event belongs to: the only routing key (design document 8.1). */
  phoneNumberId: string
  waMessageId: string
  timestamp: Date
}

export interface InboundMessageEvent extends EventBase {
  kind: 'inbound_message'
  /** Customer WhatsApp id (digits only). */
  from: string
  profileName: string | null
  type: MessageType
  /** Text body, media caption or the title of the tapped button. */
  body: string | null
  /** Id of the tapped button or list row, for interactive replies. */
  replyId: string | null
  waMediaId: string | null
}

export interface StatusUpdateEvent extends EventBase {
  kind: 'status_update'
  status: DeliveryStatus
  pricing: { billable: boolean | null; category: string | null } | null
  errorText: string | null
}

/** Meta reviewed a template. Templates belong to a WhatsApp Business Account, not to a number. */
export interface TemplateStatusEvent {
  kind: 'template_status'
  /** WABA the template lives in: the routing key for this event (entry.id). */
  wabaId: string
  metaTemplateId: string
  /** Meta's event, upper case: APPROVED, REJECTED, PAUSED, DISABLED... */
  event: string
  /** Why it was rejected, when Meta says. */
  reason: string | null
}

/** Events about a number's messages, routed by phone_number_id. */
export type NumberEvent = InboundMessageEvent | StatusUpdateEvent

export type WhatsAppEvent = NumberEvent | TemplateStatusEvent

/** What identifies an event's owner in logs and notes ("unroutable: ..."). */
export const routingKeyOf = (event: WhatsAppEvent): string =>
  event.kind === 'template_status' ? `waba ${event.wabaId}` : event.phoneNumberId

export const eventIdOf = (event: WhatsAppEvent): string =>
  event.kind === 'template_status' ? `template ${event.metaTemplateId}` : event.waMessageId

export type SkipReason =
  | 'invalid_envelope'
  | 'missing_phone_number_id'
  | 'invalid_template_status'
  | 'invalid_message'
  | 'invalid_status'
  | 'unknown_status'

export interface ParseResult {
  events: WhatsAppEvent[]
  skipped: SkipReason[]
}

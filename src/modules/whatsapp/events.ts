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
  /** A document's name as the sender wrote it; null or absent for everything else. */
  fileName?: string | null
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

/** What a message holds, the same for every source: Meta's variants mapped onto one flat shape. */
export type MessageContent = Pick<InboundMessageEvent, 'type' | 'body' | 'replyId' | 'waMediaId' | 'fileName'>

/**
 * The owner wrote to a customer from the WhatsApp Business app (coexistence): Meta echoes it so the
 * conversation in Vortomi is complete.
 */
export interface OwnerEchoEvent extends EventBase, MessageContent {
  kind: 'owner_echo'
  /** Customer WhatsApp id (digits only). */
  to: string
}

/** One message of the owner's app history: written by the customer or, `fromBusiness`, by the owner. */
export interface HistoryMessage extends MessageContent {
  waMessageId: string
  timestamp: Date
  fromBusiness: boolean
}

/**
 * A chunk of the chats the owner's app shares once, right after coexistence onboarding (up to 180
 * days, no groups). Chunks arrive in any order and may repeat: each message is stored once.
 */
export interface HistoryChunkEvent {
  kind: 'history_chunk'
  phoneNumberId: string
  /** 0: last day, 1: up to 90 days, 2: up to 180 days. */
  phase: number
  chunkOrder: number
  /** 0 to 100; 100 = the whole history arrived. */
  progress: number
  threads: { waId: string; messages: HistoryMessage[] }[]
}

/** A photo, audio, video, document or sticker of the history, sent apart from its placeholder. */
export interface HistoryMediaItem extends MessageContent {
  /** Same id as the placeholder of the history chunk: it is how the two meet. */
  waMessageId: string
  timestamp: Date
  /** The customer of the thread; null when Meta only gives a username (it can then only fill a placeholder). */
  customerWaId: string | null
  fromBusiness: boolean
}

/**
 * The media of the history, for messages of the last 14 days before onboarding: Meta first sends a
 * content-less "media_placeholder" in the history chunk and then each file in a webhook of its own.
 * Either may arrive first.
 */
export interface HistoryMediaEvent {
  kind: 'history_media'
  phoneNumberId: string
  items: HistoryMediaItem[]
}

/** Contacts of the owner's app: saved or edited ('add'), or deleted ('remove'). */
export interface ContactSyncEvent {
  kind: 'contact_sync'
  phoneNumberId: string
  contacts: { waId: string; fullName: string | null; action: 'add' | 'remove'; timestamp: Date }[]
}

/**
 * Something happened to a WhatsApp Business Account (account_update): the owner disconnected it from
 * the WhatsApp Business app, Meta restricted or disabled it, it was deleted or reconnected. Routed
 * by the account, like templates.
 */
export interface AccountUpdateEvent {
  kind: 'account_update'
  wabaId: string
  /** Meta's event, upper case: PARTNER_REMOVED, DISABLED_UPDATE, ACCOUNT_RESTRICTION... */
  event: string
  /** PARTNER_REMOVED of a coexistence number: why (ACCOUNT_DISCONNECTED, CHANGE_NUMBER...) and who (USER, SYSTEM). */
  disconnection: { reason: string | null; initiatedBy: string | null } | null
  /** DISABLED_UPDATE: DISABLE, REINSTATE, SCHEDULE_FOR_DISABLE... */
  banState: string | null
  /** ACCOUNT_RESTRICTION: how many restrictions are in force (0 = lifted). */
  restrictions: number | null
}

/** Events about a number's messages, routed by phone_number_id. */
export type NumberEvent = InboundMessageEvent | StatusUpdateEvent | OwnerEchoEvent | HistoryChunkEvent | HistoryMediaEvent | ContactSyncEvent

export type WhatsAppEvent = NumberEvent | TemplateStatusEvent | AccountUpdateEvent

/** What identifies an event's owner in logs and notes ("unroutable: ..."). */
export const routingKeyOf = (event: WhatsAppEvent): string =>
  event.kind === 'template_status' || event.kind === 'account_update' ? `waba ${event.wabaId}` : event.phoneNumberId

export const eventIdOf = (event: WhatsAppEvent): string => {
  switch (event.kind) {
    case 'template_status':
      return `template ${event.metaTemplateId}`
    case 'account_update':
      return `account ${event.event}`
    case 'history_chunk':
      return `history ${event.phase}/${event.chunkOrder}`
    case 'history_media':
      return `history media ${event.items[0]?.waMessageId ?? 'none'}`
    case 'contact_sync':
      return `contacts ${event.contacts.length}`
    case 'inbound_message':
    case 'status_update':
    case 'owner_echo':
      return event.waMessageId
  }
}

export type SkipReason =
  | 'invalid_envelope'
  | 'missing_phone_number_id'
  | 'invalid_template_status'
  | 'invalid_message'
  | 'invalid_status'
  | 'unknown_status'
  | 'invalid_echo'
  | 'invalid_history'
  /** The owner turned off sharing the chat history in the WhatsApp Business app (Meta 2593109). */
  | 'history_declined'
  | 'invalid_history_media'
  | 'invalid_contact_sync'
  | 'invalid_account_update'

export interface ParseResult {
  events: WhatsAppEvent[]
  skipped: SkipReason[]
}

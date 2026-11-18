import { DELIVERY_STATUSES, type DeliveryStatus, type MessageType } from '../../db/schema/enums.ts'
import type { MessageContent } from './events.ts'
import type { RawMessage } from './payload.schema.ts'

export const fromUnixSeconds = (value: string): Date => new Date(Number(value) * 1000)

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const
type MediaType = (typeof MEDIA_TYPES)[number]
const isMediaType = (type: string): type is MediaType => (MEDIA_TYPES as readonly string[]).includes(type)
export const isDeliveryStatus = (status: string): status is DeliveryStatus =>
  (DELIVERY_STATUSES as readonly string[]).includes(status)

/** A document name fit to show and to put in a download: no path, no control characters, 240 at most. */
function cleanFileName(name: string | undefined): string | null {
  const last = name?.split(/[\\/]/).at(-1) ?? ''
  const clean = [...last].filter((c) => c >= ' ' && c !== '\u007f').join('').trim().slice(0, 240)
  return clean ? clean : null
}

/** Maps Meta's message variants onto one flat shape. Unknown types are kept as "unsupported". */
export function toContent(message: RawMessage): MessageContent {
  const empty = { body: null, replyId: null, waMediaId: null, fileName: null }

  if (message.type === 'text' && message.text) return { ...empty, type: 'text', body: message.text.body }

  if (isMediaType(message.type)) {
    const media = message[message.type]
    if (media) {
      const fileName = message.type === 'document' ? cleanFileName(media.filename) : null
      return { ...empty, type: message.type, body: media.caption ?? null, waMediaId: media.id, fileName }
    }
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

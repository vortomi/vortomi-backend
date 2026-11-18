import type { MessageType } from '../../db/schema/enums.ts'

/**
 * The customer sent a file and nothing else (2026-11-18, the user's texts, option B of each). The
 * agent can neither see nor hear it, so it never pretends to: it says, in first person and
 * informally, that it got it, and a person takes the conversation.
 */
export const MEDIA_ACK: Partial<Record<MessageType, string>> = {
  image: '¡Listo, me llegó la foto! Ya te confirmo 😊',
  audio: '¡Recibido! Ya te respondo 😊',
  document: '¡Me llegó el documento! Dame un momentico 😊',
  video: '¡Recibido! Déjame verlo y te respondo 😊',
}

/** «Dame un momentico» would promise a quick answer that will not come while the business is closed. */
export const MEDIA_ACK_CLOSED = '¡Recibido! 😊 Ahorita estamos cerrados, pero apenas abramos te respondo.'

/** How a file shows in the conversation the model reads: it knows one came, and what it said. */
const LABEL: Partial<Record<MessageType, string>> = { image: 'photo', audio: 'voice note', document: 'document', video: 'video', sticker: 'sticker' }

export function historyText(type: MessageType, body: string | null): string {
  const text = body?.trim()
  const label = LABEL[type]
  if (!label) return text || `[${type}]`
  return text ? `[${label}] ${text}` : `[${label}]`
}

export interface PendingMessage {
  type: MessageType
  body: string | null
}

/**
 * What to do with what the customer wrote since the business last answered (newest first):
 * a file with no text of its own gets the fixed line of its kind (the newest one) and goes to a
 * person; stickers alone get no answer, like an emoji; anything else is the model's (null).
 */
export function mediaTurn(pending: PendingMessage[], openNow: boolean): { reply: string } | 'silent' | null {
  const file = pending.find((m) => MEDIA_ACK[m.type] && !m.body?.trim())
  if (file) return { reply: openNow ? MEDIA_ACK[file.type]! : MEDIA_ACK_CLOSED }
  if (pending.length && pending.every((m) => m.type === 'sticker' && !m.body?.trim())) return 'silent'
  return null
}

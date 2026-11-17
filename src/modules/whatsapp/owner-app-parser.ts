import { z } from 'zod'
import type { ContactSyncEvent, HistoryChunkEvent, HistoryMessage, ParseResult } from './events.ts'
import { fromUnixSeconds, toContent } from './message-content.ts'
import { messageSchema } from './payload.schema.ts'

/**
 * The three webhooks of a coexistence number (the owner keeps the WhatsApp Business app): what the
 * owner writes from the phone (smb_message_echoes), the chats shared once after onboarding
 * (history) and the app's contacts (smb_app_state_sync). Each item is validated on its own, like
 * the messages: one odd item never discards the rest.
 */

const digits = /^\d+$/
/** Meta's error when the owner chose not to share the chat history. */
const HISTORY_DECLINED = 2593109

const echoSchema = messageSchema.extend({ to: z.string().regex(digits) })

const historySchema = z.array(
  z
    .object({
      metadata: z
        .object({ phase: z.coerce.number().int().min(0), chunk_order: z.coerce.number().int().min(0), progress: z.coerce.number().min(0).max(100) })
        .optional(),
      threads: z
        .array(
          z
            .object({
              // The customer's number; omitted for customers known only by a WhatsApp username.
              id: z.string().optional(),
              context: z.object({ wa_id: z.string().optional() }).loose().optional(),
              messages: z.array(z.unknown()).default([]),
            })
            .loose(),
        )
        .default([]),
      errors: z.array(z.object({ code: z.number() }).loose()).optional(),
    })
    .loose(),
)

const stateSyncSchema = z.array(
  z
    .object({
      type: z.string(),
      contact: z.object({ full_name: z.string().optional(), phone_number: z.string().optional() }).loose().optional(),
      action: z.string(),
      metadata: z.object({ timestamp: z.string().regex(digits) }).loose().optional(),
    })
    .loose(),
)

/** Digits of a phone number as the app wrote it ("+58 412-555 0101"), or null. */
function waIdOf(value: string | undefined): string | null {
  const clean = value?.replace(/\D/g, '') ?? ''
  return clean.length >= 7 && clean.length <= 15 ? clean : null
}

export function parseEchoes(raw: unknown[], phoneNumberId: string, result: ParseResult): void {
  for (const item of raw) {
    const echo = echoSchema.safeParse(item)
    // Without the customer's number (username only) there is no contact to put it under.
    if (!echo.success) {
      result.skipped.push('invalid_echo')
      continue
    }
    result.events.push({
      kind: 'owner_echo',
      phoneNumberId,
      waMessageId: echo.data.id,
      to: echo.data.to,
      timestamp: fromUnixSeconds(echo.data.timestamp),
      ...toContent(echo.data),
    })
  }
}

export function parseHistory(raw: unknown, phoneNumberId: string, result: ParseResult): void {
  const chunks = historySchema.safeParse(raw)
  if (!chunks.success) {
    result.skipped.push('invalid_history')
    return
  }
  for (const chunk of chunks.data) {
    if (chunk.errors?.some((e) => e.code === HISTORY_DECLINED)) {
      result.skipped.push('history_declined')
      continue
    }
    if (!chunk.metadata) {
      result.skipped.push('invalid_history')
      continue
    }
    const threads: HistoryChunkEvent['threads'] = []
    for (const thread of chunk.threads) {
      const waId = waIdOf(thread.context?.wa_id ?? thread.id)
      if (!waId) {
        result.skipped.push('invalid_history')
        continue
      }
      const messages: HistoryMessage[] = []
      for (const item of thread.messages) {
        const message = messageSchema.safeParse(item)
        if (!message.success) {
          result.skipped.push('invalid_history')
          continue
        }
        messages.push({
          waMessageId: message.data.id,
          timestamp: fromUnixSeconds(message.data.timestamp),
          // Anything not written by the customer of the thread was written by the business.
          fromBusiness: message.data.from !== waId,
          // Media arrives as "media_placeholder", without the file: it reads as unsupported.
          ...toContent(message.data),
        })
      }
      if (messages.length) threads.push({ waId, messages })
    }
    result.events.push({
      kind: 'history_chunk',
      phoneNumberId,
      phase: chunk.metadata.phase,
      chunkOrder: chunk.metadata.chunk_order,
      progress: chunk.metadata.progress,
      threads,
    })
  }
}

export function parseContactSync(raw: unknown, phoneNumberId: string, result: ParseResult): void {
  const items = stateSyncSchema.safeParse(raw)
  if (!items.success) {
    result.skipped.push('invalid_contact_sync')
    return
  }
  const contacts: ContactSyncEvent['contacts'] = []
  for (const item of items.data) {
    const waId = waIdOf(item.contact?.phone_number)
    if (item.type !== 'contact' || (item.action !== 'add' && item.action !== 'remove') || !waId || !item.metadata) {
      result.skipped.push('invalid_contact_sync')
      continue
    }
    const fullName = item.contact?.full_name?.trim().slice(0, 120) || null
    contacts.push({ waId, fullName, action: item.action, timestamp: fromUnixSeconds(item.metadata.timestamp) })
  }
  if (contacts.length) result.events.push({ kind: 'contact_sync', phoneNumberId, contacts })
}

import { z } from 'zod'

/**
 * Zod shapes for the parts of Meta's webhook we read. Each message and status
 * is validated on its own: Meta ships new fields and types without notice,
 * and one unexpected item must not discard the rest of the batch.
 */

export const envelopeSchema = z.object({
  object: z.string().optional(),
  entry: z.array(
    z.object({
      // WhatsApp Business Account id: the routing key of account-level fields (templates).
      // Checked where it is used, so an odd value never discards the messages beside it.
      id: z.string().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            // Digits only: it becomes a routing key and a database lookup.
            metadata: z.object({ phone_number_id: z.string().regex(/^\d+$/) }).optional(),
            contacts: z.array(z.unknown()).optional(),
            messages: z.array(z.unknown()).optional(),
            statuses: z.array(z.unknown()).optional(),
          }).loose(),
        }),
      ),
    }),
  ),
})

export const contactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string().optional() }).optional(),
})

const mediaSchema = z.object({ id: z.string(), caption: z.string().optional() })

export const messageSchema = z.object({
  id: z.string().min(1),
  from: z.string().regex(/^\d+$/),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  video: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  button: z.object({ text: z.string(), payload: z.string().optional() }).optional(),
  reaction: z.object({ emoji: z.string().optional() }).optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
})

export type RawMessage = z.infer<typeof messageSchema>

export const statusSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().regex(/^\d+$/),
  pricing: z.object({ billable: z.boolean().optional(), category: z.string().optional() }).optional(),
  errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional() })).optional(),
})

/** value of a message_template_status_update change (Meta webhook reference). */
export const templateStatusSchema = z.object({
  event: z.string().min(1),
  // A number in Meta's JSON; kept as text, it is an id, not a quantity.
  message_template_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(String),
  reason: z.string().nullable().optional(),
  rejection_info: z.object({ reason: z.string().optional() }).optional(),
})

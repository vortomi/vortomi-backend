import { z } from 'zod'

/**
 * Keyset cursor (position after the last row seen). `at` is Postgres' own text of
 * the timestamp, so microseconds survive the round trip that a JS Date would cut.
 * Opaque to the client: base64url JSON.
 */
export interface Cursor {
  at: string
  id: string
}

const cursorSchema = z.object({ at: z.string().min(10).max(40), id: z.uuid() })

export const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url')

/** Undefined for a cursor that is not ours: the caller starts from the top. */
export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const PAGE_SIZE = { default: 30, max: 100 } as const

/** Escapes LIKE wildcards so a search for "50%" means the text "50%". */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

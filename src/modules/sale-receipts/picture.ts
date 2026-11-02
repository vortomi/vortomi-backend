import { z } from 'zod'

// Pictures the team uploads (a receipt logo, its own receipt): PNG or JPEG sent as base64 by the
// panel. Checked by their first bytes, not by the name or the type the browser claims.

export type PictureType = 'image/png' | 'image/jpeg'

/** Not the picture it says it is, or too large. */
export class InvalidPictureError extends Error {
  constructor() {
    super('Only PNG or JPEG pictures, within the size limit')
    this.name = 'InvalidPictureError'
  }
}

const SIGNATURES: Record<PictureType, number[]> = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] }

export const pictureInput = (maxBytes: number) => z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.base64().max(Math.ceil(maxBytes / 3) * 4) })
export type PictureInput = z.infer<ReturnType<typeof pictureInput>>

export function readPicture(input: PictureInput, maxBytes: number): { bytes: Buffer; mimeType: PictureType } {
  const bytes = Buffer.from(input.data, 'base64')
  const signature = SIGNATURES[input.mimeType]
  if (!bytes.length || bytes.length > maxBytes || !signature.every((byte, i) => bytes[i] === byte)) throw new InvalidPictureError()
  return { bytes, mimeType: input.mimeType }
}

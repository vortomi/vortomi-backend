import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Validates Meta's X-Hub-Signature-256 header.
 *
 * The HMAC must be computed over the exact bytes Meta sent. Re-serializing the
 * parsed JSON changes key order and whitespace, and the signature never matches.
 */
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false

  const hex = signatureHeader.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false

  const received = Buffer.from(hex, 'hex')
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  return timingSafeEqual(received, expected)
}

/** Constant-time string comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

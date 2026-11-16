import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Validates Meta's X-Hub-Signature-256 header against the secret of any of the platform's apps
 * (a test app and the published one can share the webhook while numbers move between them).
 *
 * The HMAC must be computed over the exact bytes Meta sent. Re-serializing the
 * parsed JSON changes key order and whitespace, and the signature never matches.
 */
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecrets: readonly string[]): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false

  const hex = signatureHeader.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false

  const received = Buffer.from(hex, 'hex')
  // Every secret is tried (no early exit), so the time taken does not tell which app matched.
  let valid = false
  for (const secret of appSecrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest()
    if (timingSafeEqual(received, expected)) valid = true
  }
  return valid
}

/** Constant-time string comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

import { WhatsAppApiError } from '../whatsapp/cloud-api.client.ts'

/** The chosen number is not in that WhatsApp Business Account (Meta says which ones are). */
export class NumberNotInAccountError extends Error {
  constructor() {
    super('That number is not in the WhatsApp Business Account')
    this.name = 'NumberNotInAccountError'
  }
}

/** Another company of the platform already has that number. */
export class NumberTakenError extends Error {
  constructor() {
    super('That number belongs to another company')
    this.name = 'NumberTakenError'
  }
}

/**
 * Why Meta refused, as the person can act on it:
 * - meta_token_invalid: the token is wrong, expired or revoked (Graph code 190).
 * - meta_permission_denied: the token may not do this; with an account of another business, our app
 *   still lacks Advanced Access (codes 10 and 200..299).
 * - meta_refused: the account does not exist or the token cannot see it (code 100, subcode 33), or anything else.
 */
export type MetaRefusal = 'meta_token_invalid' | 'meta_permission_denied' | 'meta_refused'

const refusalFor = (metaCode: number | null): MetaRefusal => {
  if (metaCode === 190) return 'meta_token_invalid'
  if (metaCode === 10 || (metaCode !== null && metaCode >= 200 && metaCode < 300)) return 'meta_permission_denied'
  return 'meta_refused'
}

/** Meta refused the call. `detail` is Meta's own message (never the token): logged by the server, never sent to the client. */
export class MetaRefusedError extends Error {
  readonly code: MetaRefusal
  readonly detail: string

  constructor(cause: WhatsAppApiError) {
    super('Meta refused the request for that account', { cause })
    this.name = 'MetaRefusedError'
    this.code = refusalFor(cause.metaCode)
    this.detail = cause.message
  }
}

/** Meta's own refusals become a clear answer; anything else stays an error of ours. */
export async function fromMeta<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (error) {
    if (error instanceof WhatsAppApiError) throw new MetaRefusedError(error)
    throw error
  }
}

import type { MediaFile } from '../chat-media/media-store.ts'
import type { SupabaseStore } from '../chat-media/supabase-store.ts'

/**
 * Where the receipts of the payments companies make to Vortomi are kept: private, read back only
 * by our server after its permission checks (documentations/18, §5).
 */
export interface PaymentProofStore {
  /** `key` is "<company>/<payment>"; writing it again replaces the receipt. */
  put(key: string, file: MediaFile): Promise<void>
  get(key: string): Promise<MediaFile>
}

/** Receipts are kept in their own private Supabase bucket, as the chat keeps its documents. */
export const PAYMENT_PROOFS_BUCKET = 'payment-proofs'

export function supabaseProofStore(store: SupabaseStore): PaymentProofStore {
  return {
    put: async (key, file) => {
      await store.put(key, 'document', file)
    },
    get: (key) => store.get(key),
  }
}

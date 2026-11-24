import type { ChatMediaKind } from '../../db/schema/index.ts'
import { type MediaFile, type MediaStore, MediaStoreError, type PutResult, fetchStored } from './media-store.ts'

/** Documents larger than this stay on the phone (the user's decision, 2026-11-18). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
const WRITE_TIMEOUT_MS = 30_000

/**
 * Documents in Supabase Storage, in a private bucket (one folder per company): the chat's documents,
 * or, in their own bucket, the receipts of the payments companies make to Vortomi. Our server alone
 * reads and writes it, with the project's secret key on the apikey header (Supabase API keys
 * guide); the panel gets the bytes from our API, after its permission checks.
 */
export class SupabaseStore implements MediaStore {
  private bucketReady: Promise<void> | null = null

  constructor(
    private readonly projectUrl: string,
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly bucket = 'chat-documents',
  ) {}

  async put(key: string, kind: ChatMediaKind, file: MediaFile): Promise<PutResult> {
    if (kind !== 'document') throw new MediaStoreError('Only documents go to Supabase Storage')
    if (file.bytes.length > MAX_DOCUMENT_BYTES) throw new MediaStoreError('Document over the limit')
    await this.ensureBucket()
    const response = await this.call('POST', `/storage/v1/object/${this.bucket}/${key}`, {
      headers: { 'content-type': file.mimeType, 'x-upsert': 'true' },
      body: new Uint8Array(file.bytes),
    })
    if (!response.ok) throw new MediaStoreError(`Supabase Storage refused the document (${response.status})`)
    return { objectKey: key, sizeBytes: file.bytes.length }
  }

  get(objectKey: string): Promise<MediaFile> {
    return fetchStored(this.fetchFn, `${this.projectUrl}/storage/v1/object/authenticated/${this.bucket}/${objectKey}`, { apikey: this.secretKey }, 'application/octet-stream')
  }

  /** The private bucket is made the first time it is needed; one that already exists is fine. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const response = await this.call('POST', '/storage/v1/bucket', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false, file_size_limit: MAX_DOCUMENT_BYTES }),
      })
      const text = response.ok ? '' : await response.text().catch(() => '')
      if (!response.ok && !/already exists|Duplicate/i.test(text)) throw new MediaStoreError(`Supabase Storage bucket could not be made (${response.status})`)
    })().catch((error: unknown) => {
      // Tried again on the next document.
      this.bucketReady = null
      throw error
    })
    return this.bucketReady
  }

  private async call(method: 'POST', path: string, init: { headers: Record<string, string>; body: string | Uint8Array }): Promise<Response> {
    try {
      return await this.fetchFn(`${this.projectUrl}${path}`, {
        method,
        headers: { apikey: this.secretKey, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      })
    } catch (error) {
      throw new MediaStoreError(`Supabase Storage could not be reached (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }
}

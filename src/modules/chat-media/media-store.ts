import type { ChatMediaKind } from '../../db/schema/index.ts'

/** Which copy of a photo: the small one for the chat, or the optimized one for the viewer. */
export type MediaVariant = 'thumb' | 'full'

export interface MediaFile {
  bytes: Buffer
  mimeType: string
}

/** Where our copy went: the key to read it back, and what was kept. */
export interface PutResult {
  objectKey: string
  sizeBytes: number
}

/**
 * Where Vortomi keeps the files of the chat. Cloudinary takes photos, voice notes and stickers;
 * Supabase Storage takes documents. Both keep them private: only our server reads them back.
 */
export interface MediaStore {
  /** `key` is unique per message ("<tenant>/<message>"); writing it again replaces the copy. */
  put(key: string, kind: ChatMediaKind, file: MediaFile): Promise<PutResult>
  get(objectKey: string, kind: ChatMediaKind, variant: MediaVariant): Promise<MediaFile>
}

/** A store could not keep or give back a file. The reason never carries a URL or a key. */
export class MediaStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaStoreError'
  }
}

const READ_TIMEOUT_MS = 30_000
/** Nothing larger than Meta's ceiling is ever read back. */
const MAX_READ_BYTES = 100 * 1024 * 1024

/** Reads a stored file over HTTPS, bounded in time and size. */
export async function fetchStored(fetchFn: typeof fetch, url: string, headers: Record<string, string>, fallbackType: string): Promise<MediaFile> {
  let response: Response
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  } catch (error) {
    throw new MediaStoreError(`Stored file could not be read (${error instanceof Error ? error.name : 'unknown'})`)
  }
  if (!response.ok) throw new MediaStoreError(`Stored file answered ${response.status}`)
  if (Number(response.headers.get('content-length') ?? '0') > MAX_READ_BYTES) throw new MediaStoreError('Stored file too large')
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackType }
}

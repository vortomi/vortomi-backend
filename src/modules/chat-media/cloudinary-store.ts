import { v2 as cloudinary } from 'cloudinary'
import type { ChatMediaKind } from '../../db/schema/index.ts'
import { type MediaFile, type MediaStore, MediaStoreError, type MediaVariant, type PutResult, fetchStored } from './media-store.ts'

/** Account details read from CLOUDINARY_URL ("cloudinary://<key>:<secret>@<cloud>"). */
export interface CloudinaryAccount {
  cloudName: string
  apiKey: string
  apiSecret: string
}

export function parseCloudinaryUrl(value: string): CloudinaryAccount {
  const url = new URL(value)
  const account = { cloudName: url.hostname, apiKey: decodeURIComponent(url.username), apiSecret: decodeURIComponent(url.password) }
  if (url.protocol !== 'cloudinary:' || !account.cloudName || !account.apiKey || !account.apiSecret) throw new Error('CLOUDINARY_URL is not cloudinary://<key>:<secret>@<cloud>')
  return account
}

// A photo gets two copies made once, when it is stored (eager): the small one for the chat and an
// optimized one for the viewer. Reading them back uses the same transformations, so nothing is
// made again (each transformation spends credits).
const PHOTO: Record<MediaVariant, { width: number; crop: string; quality: string; format: string }> = {
  thumb: { width: 320, crop: 'limit', quality: 'auto', format: 'webp' },
  full: { width: 1600, crop: 'limit', quality: 'auto', format: 'webp' },
}
// Voice notes come as OGG/Opus, which not every browser plays: one MP3 copy, made once.
const VOICE = { format: 'mp3' }
const FOLDER = 'vortomi'

/**
 * Photos, voice notes and stickers in Cloudinary, as "authenticated" assets: nobody opens them
 * without a URL signed with our secret. On the free plan those URLs never expire, so they never
 * leave the server: the panel gets the bytes from our API, after its permission checks.
 */
export class CloudinaryStore implements MediaStore {
  constructor(
    account: CloudinaryAccount,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    cloudinary.config({ cloud_name: account.cloudName, api_key: account.apiKey, api_secret: account.apiSecret, secure: true })
  }

  async put(key: string, kind: ChatMediaKind, file: MediaFile): Promise<PutResult> {
    if (kind === 'document') throw new MediaStoreError('Documents go to Supabase Storage')
    try {
      const result = await cloudinary.uploader.upload(`data:${file.mimeType};base64,${file.bytes.toString('base64')}`, {
        public_id: `${FOLDER}/${key}`,
        resource_type: kind === 'audio' ? 'video' : 'image',
        type: 'authenticated',
        overwrite: true,
        ...(kind === 'image' ? { eager: [PHOTO.thumb, PHOTO.full] } : kind === 'audio' ? { eager: [VOICE] } : {}),
      })
      return { objectKey: result.public_id, sizeBytes: result.bytes }
    } catch (error) {
      // The SDK's error may quote the request: only its message's kind is kept.
      throw new MediaStoreError(`Cloudinary refused the file (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }

  get(objectKey: string, kind: ChatMediaKind, variant: MediaVariant): Promise<MediaFile> {
    const delivery = { type: 'authenticated', sign_url: true, secure: true }
    const url =
      kind === 'image'
        ? cloudinary.url(objectKey, { ...delivery, resource_type: 'image', ...PHOTO[variant] })
        : kind === 'audio'
          ? cloudinary.url(objectKey, { ...delivery, resource_type: 'video', ...VOICE })
          : cloudinary.url(objectKey, { ...delivery, resource_type: 'image' })
    const fallback = kind === 'image' ? 'image/webp' : kind === 'audio' ? 'audio/mpeg' : 'image/webp'
    return fetchStored(this.fetchFn, url, {}, fallback)
  }
}

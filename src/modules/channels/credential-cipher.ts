import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const FORMAT = 'v1'

export class CredentialDecryptionError extends Error {
  constructor() {
    super('Stored credential cannot be decrypted with the configured key')
    this.name = 'CredentialDecryptionError'
  }
}

/**
 * Encrypts channel access tokens at rest (AES-256-GCM, random IV per value).
 * `context` is bound as additional authenticated data: a ciphertext copied to
 * another channel's row fails to decrypt instead of handing over the token.
 * Stored form: v1.<keyId>.<iv>.<tag>.<ciphertext>, base64url parts.
 */
export class CredentialCipher {
  private readonly key: Buffer

  constructor(
    base64Key: string,
    private readonly keyId = 'k1',
  ) {
    this.key = Buffer.from(base64Key, 'base64')
    if (this.key.length !== 32) throw new Error('Credential key must be 32 bytes (base64)')
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    cipher.setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [FORMAT, this.keyId, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.')
  }

  decrypt(stored: string, context: string): string {
    const [format, keyId, iv, tag, ciphertext] = stored.split('.')
    if (format !== FORMAT || keyId !== this.keyId || !iv || !tag || !ciphertext) throw new CredentialDecryptionError()
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64url'))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new CredentialDecryptionError()
    }
  }
}

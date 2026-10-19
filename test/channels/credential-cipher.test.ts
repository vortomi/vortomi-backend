import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CredentialCipher, CredentialDecryptionError } from '../../src/modules/channels/credential-cipher.ts'

const key = () => randomBytes(32).toString('base64')

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher(key())

  it('round-trips a token, with a different ciphertext each time', () => {
    const first = cipher.encrypt('EAAG-secret', 'ctx')
    expect(cipher.decrypt(first, 'ctx')).toBe('EAAG-secret')
    expect(cipher.encrypt('EAAG-secret', 'ctx')).not.toBe(first)
  })

  it('refuses another context, a tampered value and another key', () => {
    const stored = cipher.encrypt('EAAG-secret', 'channel-1')
    expect(() => cipher.decrypt(stored, 'channel-2')).toThrow(CredentialDecryptionError)
    const parts = stored.split('.')
    parts[4] = Buffer.from('tampered').toString('base64url')
    expect(() => cipher.decrypt(parts.join('.'), 'channel-1')).toThrow(CredentialDecryptionError)
    expect(() => new CredentialCipher(key()).decrypt(stored, 'channel-1')).toThrow(CredentialDecryptionError)
  })

  it('requires a 32-byte key', () => {
    expect(() => new CredentialCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})

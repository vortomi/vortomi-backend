import { describe, expect, it } from 'vitest'
import { safeEqual, verifyMetaSignature } from '../../src/modules/whatsapp/signature.ts'
import { APP_SECRET, sign } from '../helpers/meta-payloads.ts'

describe('verifyMetaSignature', () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}'

  it('accepts the HMAC of the exact raw bytes', () => {
    expect(verifyMetaSignature(Buffer.from(body), sign(body), APP_SECRET)).toBe(true)
  })

  it('rejects a body re-serialized with different whitespace', () => {
    const reserialized = JSON.stringify(JSON.parse(body), null, 2)
    expect(verifyMetaSignature(Buffer.from(reserialized), sign(body), APP_SECRET)).toBe(false)
  })

  it('rejects a signature made with another secret', () => {
    expect(verifyMetaSignature(Buffer.from(body), sign(body, 'another-secret'), APP_SECRET)).toBe(false)
  })

  it.each([undefined, '', 'sha1=abc', 'sha256=', 'sha256=zz', `sha256=${'a'.repeat(63)}`])(
    'rejects the malformed header %s without throwing',
    (header) => {
      expect(verifyMetaSignature(Buffer.from(body), header, APP_SECRET)).toBe(false)
    },
  )
})

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('token', 'token')).toBe(true)
    expect(safeEqual('token', 'token-longer')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })
})

// The verify token travels in the webhook URL: it must never be written to the logs.
import { describe, expect, it } from 'vitest'
import { redactUrl } from '../../src/app.ts'

describe('redactUrl', () => {
  it('hides the verify token in both spellings Meta uses, and keeps the rest', () => {
    const url = '/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=123&hub.verify_token=secret&hub_verify_token=secret2&x=1'
    expect(redactUrl(url)).toBe('/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=123&hub.verify_token=[Redacted]&hub_verify_token=[Redacted]&x=1')
  })

  it('leaves URLs without secrets untouched', () => {
    expect(redactUrl('/api/me?limit=10')).toBe('/api/me?limit=10')
  })
})

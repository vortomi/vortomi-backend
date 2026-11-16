// The platform can have more than one Meta app sharing the webhook: the extra secrets are optional,
// comma-separated, and a short one stops the server instead of weakening the signature check.
import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv } from '../../src/config/env.ts'

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SUPABASE_URL: 'https://example.supabase.co',
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  META_APP_SECRET: 'a'.repeat(32),
  WEBHOOK_VERIFY_TOKEN: 'v'.repeat(24),
}

describe('META_ADDITIONAL_APP_SECRETS', () => {
  it('is empty when unset or blank', () => {
    expect(loadEnv({ ...base }).META_ADDITIONAL_APP_SECRETS).toEqual([])
    expect(loadEnv({ ...base, META_ADDITIONAL_APP_SECRETS: '  ' }).META_ADDITIONAL_APP_SECRETS).toEqual([])
  })

  it('splits and trims a comma-separated list', () => {
    const env = loadEnv({ ...base, META_ADDITIONAL_APP_SECRETS: ` ${'b'.repeat(32)} , ${'c'.repeat(32)} ,` })
    expect(env.META_ADDITIONAL_APP_SECRETS).toEqual(['b'.repeat(32), 'c'.repeat(32)])
  })

  it('refuses a secret that is too short', () => {
    expect(() => loadEnv({ ...base, META_ADDITIONAL_APP_SECRETS: 'short' })).toThrow(EnvValidationError)
  })
})

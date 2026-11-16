// The platform can have more than one Meta app sharing the webhook: the extra secrets are optional,
// comma-separated, and a short one stops the server instead of weakening the signature check.
import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv, signupSettings } from '../../src/config/env.ts'

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

describe('«Conectar WhatsApp» (Embedded Signup) settings', () => {
  const signup = { META_SIGNUP_APP_ID: '1167128472338629', META_SIGNUP_APP_SECRET: 's'.repeat(32), META_SIGNUP_CONFIG_ID: '3023822601294020' }

  it('off when none is set; on with the three', () => {
    expect(signupSettings(loadEnv({ ...base }))).toBeNull()
    expect(signupSettings(loadEnv({ ...base, ...signup }))).toEqual({ appId: '1167128472338629', appSecret: 's'.repeat(32), configId: '3023822601294020' })
  })

  it('one missing stops the server instead of half a button', () => {
    expect(() => loadEnv({ ...base, ...signup, META_SIGNUP_CONFIG_ID: undefined })).toThrow(EnvValidationError)
    expect(() => loadEnv({ ...base, META_SIGNUP_APP_ID: 'abc', META_SIGNUP_APP_SECRET: 's'.repeat(32), META_SIGNUP_CONFIG_ID: '1' })).toThrow(EnvValidationError)
  })
})

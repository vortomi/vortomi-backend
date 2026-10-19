import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { InvalidAccessTokenError } from '../../src/modules/access/identity.ts'
import { ISSUER, testVerifier, tokenFor } from '../helpers/auth.ts'

const verifier = testVerifier()
const userId = randomUUID()

describe('Supabase access token verification', () => {
  it('accepts a valid token and reads who the caller is', async () => {
    const identity = await verifier.verify(await tokenFor(userId, { email: 'Laura@Repuestos.com', aal: 'aal2' }))
    expect(identity).toEqual({ userId, email: 'laura@repuestos.com', secondFactor: true })
  })

  it('tells a password-only session apart', async () => {
    expect((await verifier.verify(await tokenFor(userId))).secondFactor).toBe(false)
  })

  it.each([
    ['expired', { expiresIn: '-1m' }],
    ['from another Supabase project', { issuer: 'https://otherproject.supabase.co/auth/v1' }],
    ['for another audience', { audience: 'anon' }],
    ['for the anon role', { role: 'anon' }],
  ])('rejects a token %s', async (_case, options) => {
    await expect(verifier.verify(await tokenFor(userId, options))).rejects.toBeInstanceOf(InvalidAccessTokenError)
  })

  it('rejects a tampered token', async () => {
    const [header, , signature] = (await tokenFor(userId)).split('.')
    const forged = Buffer.from(JSON.stringify({ sub: randomUUID(), role: 'authenticated', aal: 'aal2', iss: ISSUER, aud: 'authenticated' })).toString('base64url')
    await expect(verifier.verify(`${header}.${forged}.${signature}`)).rejects.toBeInstanceOf(InvalidAccessTokenError)
  })

  it('rejects a shared-secret (HS256) token even with the right claims', async () => {
    const token = await new SignJWT({ email: 'x@example.com', role: 'authenticated', aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-secret-anyone-could-guess-123456'))
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidAccessTokenError)
  })

  it('rejects garbage', async () => {
    await expect(verifier.verify('not-a-token')).rejects.toBeInstanceOf(InvalidAccessTokenError)
  })
})

import { type JWTVerifyGetKey, createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import { z } from 'zod'
import { type AccessTokenVerifier, InvalidAccessTokenError, type VerifiedIdentity } from './identity.ts'

/**
 * Asymmetric algorithms only. A shared-secret (HS256) project would let anyone who
 * holds that secret mint tokens; Supabase's signing keys publish just the public half.
 */
const ALGORITHMS = ['ES256', 'RS256']

/** The claims we rely on. Anything else in the token is ignored. */
const claimsSchema = z.object({
  sub: z.uuid(),
  email: z.email().transform((email) => email.toLowerCase()),
  role: z.literal('authenticated'),
  aal: z.enum(['aal1', 'aal2']),
})

/**
 * Verifies Supabase Auth access tokens locally against the project's public keys
 * (JWKS, cached and refreshed by jose): signature, issuer, audience and expiry.
 * No call to Supabase per request.
 */
export class SupabaseTokenVerifier implements AccessTokenVerifier {
  private readonly issuer: string
  private readonly keys: JWTVerifyGetKey

  /** `keys` is only for tests; production reads `<project>/auth/v1/.well-known/jwks.json`. */
  constructor(supabaseUrl: string, keys?: JWTVerifyGetKey) {
    const base = supabaseUrl.replace(/\/+$/, '')
    this.issuer = `${base}/auth/v1`
    this.keys = keys ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`))
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: unknown
    try {
      ;({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ALGORITHMS,
        requiredClaims: ['exp', 'sub'],
      }))
    } catch (error) {
      // Only token problems become 401. A JWKS outage (timeout, or jose's generic error for a
      // bad JWKS response) must surface as a server error, not as "sign in again".
      if (error instanceof joseErrors.JOSEError && error.code !== 'ERR_JOSE_GENERIC' && !(error instanceof joseErrors.JWKSTimeout)) {
        throw new InvalidAccessTokenError(error.code)
      }
      throw error
    }
    const claims = claimsSchema.safeParse(payload)
    if (!claims.success) throw new InvalidAccessTokenError('unexpected claims')
    return { userId: claims.data.sub, email: claims.data.email, secondFactor: claims.data.aal === 'aal2' }
  }
}

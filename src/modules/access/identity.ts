/** Who is calling, as proven by a verified access token. Nothing else about the caller is trusted. */
export interface VerifiedIdentity {
  /** Supabase Auth user id; also users.id. */
  readonly userId: string
  readonly email: string
  /** aal2 = signed in with the second factor too. */
  readonly secondFactor: boolean
}

export interface AccessTokenVerifier {
  /** Resolves the identity or throws InvalidAccessTokenError; never returns a partial result. */
  verify(token: string): Promise<VerifiedIdentity>
}

export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid access token: ${reason}`)
    this.name = 'InvalidAccessTokenError'
  }
}

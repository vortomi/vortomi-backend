import type { FastifyRequest } from 'fastify'
import { type AccessTokenVerifier, InvalidAccessTokenError, type VerifiedIdentity } from '../modules/access/identity.ts'
import { unauthorized } from './errors.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by authenticate(); null only before the hook ran. */
    identity: VerifiedIdentity | null
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/

/** onRequest hook: no valid Supabase access token, no API. Runs before body parsing. */
export function authenticate(verifier: AccessTokenVerifier) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
    if (!token) throw unauthorized('missing_token')
    try {
      request.identity = await verifier.verify(token)
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw unauthorized('invalid_token')
      throw error
    }
  }
}

export function identityOf(request: FastifyRequest): VerifiedIdentity {
  if (!request.identity) throw unauthorized()
  return request.identity
}

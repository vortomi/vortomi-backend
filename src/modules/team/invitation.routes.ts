import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import { identityOf } from '../../http/authenticate.ts'
import { parseInput } from '../../http/validation.ts'
import type { InvitationService } from './invitation-service.ts'

export interface InvitationRoutesOptions {
  invitations: InvitationService
}

// Base64url of 32 random bytes; anything else is not one of ours.
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
// The person may correct the name the admin typed; without it, the invitation's name is used.
const acceptBody = z.object({ name: z.string().trim().min(1).max(80).optional() }).default({})

/** Without a session: what the invitation page shows. The token itself is the secret. */
export const publicInvitationRoutes: FastifyPluginCallback<InvitationRoutesOptions> = (app, { invitations }, done) => {
  app.get('/invitations/:token', (request) => invitations.preview(parseInput(tokenParams, request.params).token))
  done()
}

/** With a session: the signed-in person accepts and joins the company. */
export const invitationRoutes: FastifyPluginCallback<InvitationRoutesOptions> = (app, { invitations }, done) => {
  app.post('/invitations/:token/accept', (request) =>
    invitations.accept(identityOf(request), parseInput(tokenParams, request.params).token, parseInput(acceptBody, request.body ?? {}).name),
  )
  done()
}

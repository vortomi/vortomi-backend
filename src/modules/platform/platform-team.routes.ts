import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import { identityOf } from '../../http/authenticate.ts'
import { parseInput } from '../../http/validation.ts'
import { type PlatformTeamService, platformInvitationInput } from './platform-team-service.ts'

export interface PlatformTeamRoutesOptions {
  team: PlatformTeamService
}

// Base64url of 32 random bytes; anything else is not one of ours.
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const invitationParams = z.object({ invitationId: z.uuid() })
const adminParams = z.object({ userId: z.uuid() })
const sessionParams = adminParams.extend({ sessionId: z.uuid() })
// The person may correct the name the inviter typed.
const acceptBody = z.object({ name: z.string().trim().min(1).max(80).optional() }).default({})

/**
 * /platform/team: who enters the console (mockup web-22). Registered inside platformRoutes, so its
 * guard (super admin with the second factor) runs first on every one of these.
 */
export const platformTeamRoutes: FastifyPluginCallback<PlatformTeamRoutesOptions> = (app, { team }, done) => {
  app.get('/team', (request) => team.overview(identityOf(request)))

  app.post('/team/invitations', async (request, reply) =>
    reply.code(201).send(await team.invite(identityOf(request).userId, parseInput(platformInvitationInput, request.body))),
  )
  app.post('/team/invitations/:invitationId/renew', (request) => team.renew(identityOf(request).userId, parseInput(invitationParams, request.params).invitationId))
  app.delete('/team/invitations/:invitationId', async (request, reply) => {
    await team.revoke(identityOf(request).userId, parseInput(invitationParams, request.params).invitationId)
    return reply.code(204).send()
  })

  app.post('/team/admins/:userId/reset-code', async (request, reply) => {
    await team.resetCode(identityOf(request).userId, parseInput(adminParams, request.params).userId)
    return reply.code(204).send()
  })
  app.delete('/team/admins/:userId', async (request, reply) => {
    await team.remove(identityOf(request).userId, parseInput(adminParams, request.params).userId)
    return reply.code(204).send()
  })

  // Staff (mockup web-28): sign a person out of every device, or out of one.
  app.delete('/team/admins/:userId/sessions', (request) => team.endSessions(identityOf(request).userId, parseInput(adminParams, request.params).userId))
  app.delete('/team/admins/:userId/sessions/:sessionId', async (request, reply) => {
    const { userId, sessionId } = parseInput(sessionParams, request.params)
    await team.endSession(identityOf(request), userId, sessionId)
    return reply.code(204).send()
  })
  done()
}

/** Without a session: what the invitation page shows. */
export const publicPlatformInvitationRoutes: FastifyPluginCallback<PlatformTeamRoutesOptions> = (app, { team }, done) => {
  app.get('/platform-invitations/:token', (request) => team.preview(parseInput(tokenParams, request.params).token))
  done()
}

/** With a session (any signed-in person, before being an admin): accepting makes them one. */
export const platformInvitationRoutes: FastifyPluginCallback<PlatformTeamRoutesOptions> = (app, { team }, done) => {
  app.post('/platform-invitations/:token/accept', (request) =>
    team.accept(identityOf(request), parseInput(tokenParams, request.params).token, parseInput(acceptBody, request.body ?? {}).name),
  )
  done()
}

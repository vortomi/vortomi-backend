import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { channelLabel, listChannels, renameChannel } from './channel-list.ts'
import { type InvitationService, invitationInput } from './invitation-service.ts'
import { type TeamService, memberStatus, memberUpdate } from './team-service.ts'

export interface TeamRoutesOptions {
  db: Database
  team: TeamService
  invitations: InvitationService
}

const userParams = z.object({ userId: z.uuid() })
const invitationParams = z.object({ invitationId: z.uuid() })
const channelParams = z.object({ channelId: z.uuid() })
const listQuery = z.object({ include: z.literal('disabled').optional() })

/**
 * /tenants/:tenantId/team, /team/invitations and /channels: who works here and on which numbers.
 * Everyone reads the team (assignment list); changing it is for admins.
 */
export const teamRoutes: FastifyPluginCallback<TeamRoutesOptions> = (app, { db, team, invitations }, done) => {
  app.get('/team', (request) =>
    inCompany(db, request, async (scope) => ({ items: await team.list(scope, parseInput(listQuery, request.query).include === 'disabled') })),
  )

  app.put('/team/:userId', async (request, reply) => {
    await asAdmin(db, request, (scope) => team.update(scope, parseInput(userParams, request.params).userId, parseInput(memberUpdate, request.body)))
    return reply.code(204).send()
  })

  app.put('/team/:userId/status', async (request, reply) => {
    await asAdmin(db, request, (scope) =>
      team.setStatus(scope, parseInput(userParams, request.params).userId, parseInput(memberStatus, request.body).status),
    )
    return reply.code(204).send()
  })

  app.get('/team/invitations', (request) => asAdmin(db, request, async (scope) => ({ items: await invitations.list(scope) })))

  app.post('/team/invitations', async (request, reply) =>
    reply.code(201).send(await asAdmin(db, request, (scope) => invitations.create(scope, parseInput(invitationInput, request.body)))),
  )

  app.post('/team/invitations/:invitationId/renew', (request) =>
    asAdmin(db, request, (scope) => invitations.renew(scope, parseInput(invitationParams, request.params).invitationId)),
  )

  app.delete('/team/invitations/:invitationId', async (request, reply) => {
    await asAdmin(db, request, (scope) => invitations.revoke(scope, parseInput(invitationParams, request.params).invitationId))
    return reply.code(204).send()
  })

  app.get('/channels', (request) => inCompany(db, request, async (scope) => ({ items: await listChannels(scope) })))

  app.put('/channels/:channelId', (request) =>
    asAdmin(db, request, (scope) => renameChannel(scope, parseInput(channelParams, request.params).channelId, parseInput(channelLabel, request.body).label)),
  )

  done()
}

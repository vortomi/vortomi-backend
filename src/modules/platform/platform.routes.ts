import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { forbidden } from '../../http/errors.ts'
import { parseInput } from '../../http/validation.ts'
import type { AccessDirectory } from '../access/access-directory.ts'
import { type UsageService, monthParam } from '../usage/usage-service.ts'
import { type TenantAdminService, adminInvitationInput, channelInput, lookupInput, tenantInput, tenantStatusInput } from './tenant-admin-service.ts'

export interface PlatformRoutesOptions {
  directory: AccessDirectory
  tenants: TenantAdminService
  db: Database
  usage: UsageService
}

const tenantParams = z.object({ tenantId: z.uuid() })
const invitationParams = tenantParams.extend({ invitationId: z.uuid() })
const sinceQuery = z.object({ since: z.iso.datetime({ offset: true }) })

/**
 * Platform console (our own team). Every route requires the super_admin role AND a
 * session signed in with the second factor (documentations/04, D12): this console
 * reaches every company, so a stolen password alone must not open it.
 */
export const platformRoutes: FastifyPluginCallback<PlatformRoutesOptions> = (app, { directory, tenants, db, usage }, done) => {
  app.addHook('preHandler', async (request) => {
    const identity = identityOf(request)
    const account = await directory.findAccount(identity.userId)
    if (account?.platformRole !== 'super_admin') throw forbidden('platform_admin_required')
    if (!identity.secondFactor) throw forbidden('second_factor_required')
  })

  const id = (params: unknown) => parseInput(tenantParams, params).tenantId

  app.get('/tenants', async () => ({ tenants: await tenants.list() }))
  app.post('/tenants', async (request, reply) => reply.code(201).send(await tenants.create(parseInput(tenantInput, request.body))))
  app.get('/tenants/:tenantId', (request) => tenants.detail(id(request.params)))
  app.put('/tenants/:tenantId', (request) => tenants.update(id(request.params), parseInput(tenantInput, request.body)))

  app.put('/tenants/:tenantId/status', async (request, reply) => {
    await tenants.setStatus(id(request.params), parseInput(tenantStatusInput, request.body).status)
    return reply.code(204).send()
  })

  // POST, not GET: the account's token travels in the body, never in a URL that gets logged.
  app.post('/tenants/:tenantId/channels/lookup', (request) => {
    const input = parseInput(lookupInput, request.body)
    return tenants.lookupNumbers(id(request.params), input.wabaId, input.accessToken)
  })
  app.post('/tenants/:tenantId/channels', async (request, reply) =>
    reply.code(201).send(await tenants.connectChannel(id(request.params), parseInput(channelInput, request.body))),
  )

  app.get('/tenants/:tenantId/inbound', (request) =>
    tenants.lastInbound(id(request.params), new Date(parseInput(sinceQuery, request.query).since)),
  )

  app.post('/tenants/:tenantId/invitations', async (request, reply) =>
    reply.code(201).send(await tenants.inviteAdmin(id(request.params), parseInput(adminInvitationInput, request.body), identityOf(request).userId)),
  )
  app.post('/tenants/:tenantId/invitations/:invitationId/renew', (request) => {
    const params = parseInput(invitationParams, request.params)
    return tenants.renewInvitation(params.tenantId, params.invitationId)
  })
  app.delete('/tenants/:tenantId/invitations/:invitationId', async (request, reply) => {
    const params = parseInput(invitationParams, request.params)
    await tenants.revokeInvitation(params.tenantId, params.invitationId)
    return reply.code(204).send()
  })

  // Counts per company and number, never content: what billing and health need.
  app.get('/usage', async (request) => ({ items: await usage.monthly(db, parseInput(z.object({ month: monthParam }), request.query).month) }))

  done()
}

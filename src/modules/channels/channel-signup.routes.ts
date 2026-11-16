import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type ChannelSignupService, signupInput } from './channel-signup-service.ts'

/** What the panel needs to open Meta's window. All public: the app id and configuration are in the page anyway. */
export interface SignupLaunch {
  appId: string
  configId: string
  graphVersion: string
}

export interface ChannelSignupRoutesOptions {
  db: Database
  signup: ChannelSignupService
  launch: SignupLaunch | null
}

/**
 * /tenants/:tenantId/channels/signup: the company's admins connect a WhatsApp number themselves
 * («Conectar WhatsApp»). Admin only: it adds a number that the whole company answers from.
 */
export const channelSignupRoutes: FastifyPluginCallback<ChannelSignupRoutesOptions> = (app, { db, signup, launch }, done) => {
  app.get('/channels/signup', (request) => asAdmin(db, request, () => Promise.resolve(launch ? { available: true, ...launch } : { available: false })))

  app.post('/channels/signup', async (request, reply) => {
    // Membership and role are proven first; Meta is called after, outside the company's transaction.
    const tenantId = await asAdmin(db, request, (scope) => Promise.resolve(scope.tenantId))
    const result = await signup.connect(tenantId, parseInput(signupInput, request.body))
    return reply.code(201).send(result)
  })

  done()
}

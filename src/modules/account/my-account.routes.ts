import type { FastifyPluginCallback, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { identityOf } from '../../http/authenticate.ts'
import { forbidden } from '../../http/errors.ts'
import { parseInput } from '../../http/validation.ts'
import type { AccessDirectory } from '../access/access-directory.ts'
import { type MyAccount, nameInput } from './my-account.ts'

export interface MyAccountRoutesOptions {
  directory: AccessDirectory
  account: MyAccount
}

const sessionParams = z.object({ sessionId: z.uuid() })

/**
 * /me/profile and friends (mockup web-29): anyone with an account, about themselves only. Our
 * staff also needs the second factor here: their devices and console activity are as sensitive as
 * the console itself.
 */
export const myAccountRoutes: FastifyPluginCallback<MyAccountRoutesOptions> = (app, { directory, account }, done) => {
  const signedIn = async (request: FastifyRequest) => {
    const identity = identityOf(request)
    const found = await directory.findAccount(identity.userId)
    if (!found) throw forbidden('no_account')
    if (found.platformRole === 'super_admin' && !identity.secondFactor) throw forbidden('second_factor_required')
    return { identity, found }
  }

  app.get('/me/profile', async (request) => {
    const { identity, found } = await signedIn(request)
    return account.profile(identity, found)
  })

  app.put('/me/name', async (request) => {
    const { identity } = await signedIn(request)
    return account.rename(identity.userId, parseInput(nameInput, request.body).name)
  })

  app.delete('/me/sessions/:sessionId', async (request, reply) => {
    const { identity } = await signedIn(request)
    await account.endSession(identity, parseInput(sessionParams, request.params).sessionId)
    return reply.code(204).send()
  })

  app.delete('/me/sessions', async (request) => {
    const { identity } = await signedIn(request)
    return account.endOtherSessions(identity)
  })
  done()
}

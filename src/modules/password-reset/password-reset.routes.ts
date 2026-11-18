import type { FastifyPluginCallback, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { newPassword } from './account-passwords.ts'
import type { CompanyAdmin, CompanyPasswordResets } from './company-password-resets.ts'
import type { PasswordResetLinks } from './password-reset-links.ts'

// Base64url of 32 random bytes; anything else is not one of ours.
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const userParams = z.object({ userId: z.uuid() })
const completeBody = z.object({ password: newPassword })

/**
 * Without a session (/api/public): the page of the link (mockup web-30). The token is the secret;
 * using it answers the email so the page can sign the person in with the password they chose.
 */
export const publicPasswordResetRoutes: FastifyPluginCallback<{ links: PasswordResetLinks }> = (app, { links }, done) => {
  app.get('/password-resets/:token', (request) => links.preview(parseInput(tokenParams, request.params).token))
  app.post('/password-resets/:token', (request) =>
    links.complete(parseInput(tokenParams, request.params).token, parseInput(completeBody, request.body).password),
  )
  done()
}

export interface CompanyPasswordResetRoutesOptions {
  db: Database
  resets: CompanyPasswordResets
}

/** /tenants/:tenantId/team/...: what the owner's team table needs, and the owner giving a link. Admins only. */
export const companyPasswordResetRoutes: FastifyPluginCallback<CompanyPasswordResetRoutesOptions> = (app, { db, resets }, done) => {
  // Proves the caller is an admin of the company and closes that scope: the work runs on the server's connection.
  const admin = (request: FastifyRequest): Promise<CompanyAdmin> =>
    asAdmin(db, request, (scope) => Promise.resolve({ tenantId: scope.tenantId, userId: scope.member.userId }))

  app.get('/team/access', async (request) => resets.access(await admin(request)))
  app.post('/team/:userId/password-reset', async (request, reply) => {
    const userId = parseInput(userParams, request.params).userId
    return reply.code(201).send(await resets.issueAsOwner(await admin(request), userId))
  })
  done()
}

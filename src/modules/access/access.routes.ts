import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { inCompany } from '../../http/company-scope.ts'
import { forbidden } from '../../http/errors.ts'
import type { AccessDirectory } from './access-directory.ts'

export interface AccessRoutesOptions {
  db: Database
  directory: AccessDirectory
}

/** Who am I, and what am I in this company: what the panel needs to start a session. */
export const accessRoutes: FastifyPluginCallback<AccessRoutesOptions> = (app, { db, directory }, done) => {
  app.get('/me', async (request) => {
    const identity = identityOf(request)
    const account = await directory.findAccount(identity.userId)
    // A valid Supabase user we never invited has nothing to see here.
    if (!account) throw forbidden('no_account')
    return {
      user: account,
      secondFactor: identity.secondFactor,
      companies: await directory.companiesOf(identity.userId),
    }
  })

  app.get('/tenants/:tenantId/me', (request) => inCompany(db, request, ({ tenantId, member }) => Promise.resolve({ tenantId, ...member })))

  done()
}

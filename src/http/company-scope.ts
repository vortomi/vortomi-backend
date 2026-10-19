import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.ts'
import { type MemberScope, withMember } from '../modules/access/member-scope.ts'
import { identityOf } from './authenticate.ts'
import { forbidden } from './errors.ts'

const companyParams = z.object({ tenantId: z.uuid() })

/** The company named in the URL (/tenants/:tenantId/...) and the verified caller. */
export function companyOf(request: FastifyRequest): { tenantId: string; userId: string } {
  const params = companyParams.safeParse(request.params)
  if (!params.success) throw forbidden('not_a_member')
  return { tenantId: params.data.tenantId, userId: identityOf(request).userId }
}

/**
 * Runs a handler inside the company named in the URL, as the caller, after proving
 * they are an active member of it. A malformed id, an unknown company and someone
 * else's company all answer the same 403 (NotAMemberError, domain-errors.ts).
 */
export function inCompany<T>(db: Database, request: FastifyRequest, work: (scope: MemberScope) => Promise<T>): Promise<T> {
  const { tenantId, userId } = companyOf(request)
  return withMember(db, tenantId, userId, work)
}

/** inCompany() for changes only admins may make: membership, role, then the work. */
export function asAdmin<T>(db: Database, request: FastifyRequest, work: (scope: MemberScope) => Promise<T>): Promise<T> {
  return inCompany(db, request, (scope) => {
    if (scope.member.role !== 'admin') throw forbidden('admin_required')
    return work(scope)
  })
}

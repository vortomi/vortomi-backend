import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { MemberRole } from '../../db/schema/enums.ts'
import { memberships, tenants } from '../../db/schema/index.ts'
import { unpaidAndSuspended } from '../subscriptions/subscription-service.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'

/** The caller's place in the company the request is about. */
export interface Member {
  readonly userId: string
  readonly role: MemberRole
  readonly canSeeOthers: boolean
}

export interface MemberScope extends TenantScope {
  readonly member: Member
}

/** The company exists but is not working: suspended (for example, unpaid) or cancelled. Its data is kept. */
export class CompanyUnavailableError extends Error {
  constructor() {
    super('This company is not active')
    this.name = 'CompanyUnavailableError'
  }
}

/**
 * The company owes Vortomi and its grace is over (documentations/18): every screen is closed but
 * Suscripción, where it pays. Only while BILLING_ENFORCEMENT is on.
 */
export class CompanyUnpaidError extends Error {
  constructor() {
    super('This company is suspended for not paying')
    this.name = 'CompanyUnpaidError'
  }
}

export class NotAMemberError extends Error {
  constructor() {
    super('Caller is not an active member of this company')
    this.name = 'NotAMemberError'
  }
}

/** An active member of the scope's company, or null. Runs under RLS. */
export async function findActiveMember(scope: TenantScope, userId: string): Promise<Member | null> {
  const { tx, tenantId } = scope
  const [membership] = await tx
    .select({ role: memberships.role, status: memberships.status, canSeeOthers: memberships.canSeeOthers })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
  if (membership?.status !== 'active') return null
  return { userId, role: membership.role, canSeeOthers: membership.canSeeOthers }
}

/**
 * Which companies a request may run in. 'working': only an active one (every screen) that is not
 * suspended for not paying. 'joining': also one waiting for its owner to connect the first number,
 * for the few routes that do exactly that. 'billing': an active one even if it owes (Suscripción).
 */
export type CompanyStage = 'working' | 'joining' | 'billing'

/**
 * withTenant() plus the proof that the caller belongs to that company. The
 * membership is read INSIDE the company's transaction, under its RLS, so the
 * answer can only come from that company's rows. Unknown company and foreign
 * company look the same to the caller: NotAMemberError.
 */
export async function withMember<T>(
  db: Database,
  tenantId: string,
  userId: string,
  work: (scope: MemberScope) => Promise<T>,
  stage: CompanyStage = 'working',
): Promise<T> {
  return withTenant(db, tenantId, async (scope) => {
    const member = await findActiveMember(scope, userId)
    if (!member) throw new NotAMemberError()
    // Only after proving membership: an outsider learns nothing about the company's state.
    const [tenant] = await scope.tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, scope.tenantId))
    const open = tenant?.status === 'active' || (stage === 'joining' && tenant?.status === 'awaiting_owner')
    if (!open) throw new CompanyUnavailableError()
    // Unpaid past its grace: only Suscripción stays open (read under the company's own RLS).
    if (stage !== 'billing' && (await unpaidAndSuspended(scope.tx, tenantId))) throw new CompanyUnpaidError()
    // Who acts, for the history the database keeps by itself (pipeline moves). Local to this
    // transaction, like app.tenant_id: it never leaks to the next use of the connection.
    await scope.tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return work({ ...scope, member })
  })
}

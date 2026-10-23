import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { MemberRole } from '../../db/schema/enums.ts'
import { membershipChannels, memberships, tenants } from '../../db/schema/index.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'

/** The caller's place in the company the request is about. */
export interface Member {
  readonly userId: string
  readonly role: MemberRole
  readonly canSeeOthers: boolean
  /** Numbers assigned to this person; admins reach every number regardless. */
  readonly channelAccountIds: readonly string[]
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

export class NotAMemberError extends Error {
  constructor() {
    super('Caller is not an active member of this company')
    this.name = 'NotAMemberError'
  }
}

/** An active member of the scope's company with their numbers, or null. Runs under RLS. */
export async function findActiveMember(scope: TenantScope, userId: string): Promise<Member | null> {
  const { tx, tenantId } = scope
  const [membership] = await tx
    .select({ role: memberships.role, status: memberships.status, canSeeOthers: memberships.canSeeOthers })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
  if (membership?.status !== 'active') return null

  const channels = await tx
    .select({ id: membershipChannels.channelAccountId })
    .from(membershipChannels)
    .where(and(eq(membershipChannels.tenantId, tenantId), eq(membershipChannels.userId, userId)))
  return { userId, role: membership.role, canSeeOthers: membership.canSeeOthers, channelAccountIds: channels.map((channel) => channel.id) }
}

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
): Promise<T> {
  return withTenant(db, tenantId, async (scope) => {
    const member = await findActiveMember(scope, userId)
    if (!member) throw new NotAMemberError()
    // Only after proving membership: an outsider learns nothing about the company's state.
    const [tenant] = await scope.tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, scope.tenantId))
    if (tenant?.status !== 'active') throw new CompanyUnavailableError()
    return work({ ...scope, member })
  })
}

import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { MEMBER_ROLES } from '../../db/schema/enums.ts'
import { membershipChannels, memberships, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

export class MemberNotFoundError extends Error {
  constructor() {
    super('That person is not in this company')
    this.name = 'MemberNotFoundError'
  }
}

export class LastAdminError extends Error {
  constructor() {
    super('The company would be left without an active admin')
    this.name = 'LastAdminError'
  }
}

export class SelfDisableError extends Error {
  constructor() {
    super('Nobody can disable themselves')
    this.name = 'SelfDisableError'
  }
}

export const memberUpdate = z.object({
  role: z.enum(MEMBER_ROLES),
  canSeeOthers: z.boolean(),
  channelAccountIds: z.array(z.uuid()).max(50),
})
export type MemberUpdate = z.infer<typeof memberUpdate>

export const memberStatus = z.object({ status: z.enum(['active', 'disabled']) })

/**
 * The people of the company, for the assignment list and the team screen.
 * users is only readable for members of this company (RLS policy on users);
 * emails are shown to admins only. Changing someone is for admins (routes).
 */
export class TeamService {
  /** Disabled people only when an admin asks for them (the team screen, to bring them back). */
  async list(scope: MemberScope, includeDisabled = false) {
    const admin = scope.member.role === 'admin'
    const rows = await scope.tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        status: memberships.status,
        canSeeOthers: memberships.canSeeOthers,
        channelAccountIds: sql<string[]>`coalesce((
          select array_agg(mc.channel_account_id order by mc.channel_account_id) from ${membershipChannels} mc
          where mc.tenant_id = ${memberships.tenantId} and mc.user_id = ${memberships.userId}), '{}')`,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, scope.tenantId), admin && includeDisabled ? undefined : ne(memberships.status, 'disabled')))
      .orderBy(asc(users.name))
    if (admin) return rows
    return rows.map(({ email: _email, ...row }) => row)
  }

  /** Role, numbers and whether they see others' conversations. Numbers of another company fail on their key. */
  async update(scope: MemberScope, userId: string, input: MemberUpdate): Promise<void> {
    const { tx, tenantId } = scope
    const current = await this.current(scope, userId)
    if (current.role === 'admin' && input.role !== 'admin') await this.assertAnotherAdmin(scope, userId)

    await tx
      .update(memberships)
      .set({ role: input.role, canSeeOthers: input.role === 'admin' || input.canSeeOthers })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    await tx.delete(membershipChannels).where(and(eq(membershipChannels.tenantId, tenantId), eq(membershipChannels.userId, userId)))
    const ids = [...new Set(input.channelAccountIds)]
    if (ids.length) await tx.insert(membershipChannels).values(ids.map((channelAccountId) => ({ tenantId, userId, channelAccountId })))
  }

  /** A disabled person keeps their history but cannot enter; bringing them back restores the same access. */
  async setStatus(scope: MemberScope, userId: string, status: 'active' | 'disabled'): Promise<void> {
    const current = await this.current(scope, userId)
    if (status === 'disabled') {
      if (userId === scope.member.userId) throw new SelfDisableError()
      if (current.role === 'admin') await this.assertAnotherAdmin(scope, userId)
    }
    await scope.tx
      .update(memberships)
      .set({ status })
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.userId, userId)))
  }

  private async current(scope: MemberScope, userId: string) {
    const [row] = await scope.tx
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.userId, userId)))
    if (!row) throw new MemberNotFoundError()
    return row
  }

  /**
   * Locks every active admin row of the company, then counts the others. Two admins demoting
   * each other at the same time serialise here, and the second one sees the first change.
   */
  private async assertAnotherAdmin(scope: MemberScope, userId: string): Promise<void> {
    const admins = await scope.tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')))
      .for('update')
    if (!admins.some((admin) => admin.userId !== userId)) throw new LastAdminError()
  }
}

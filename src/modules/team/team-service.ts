import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { membershipChannels, memberships, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

/**
 * The people of the company, for the assignment list and the team screen.
 * users is only readable for members of this company (RLS policy on users);
 * emails are shown to admins only.
 */
export class TeamService {
  async list(scope: MemberScope) {
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
      .where(and(eq(memberships.tenantId, scope.tenantId), ne(memberships.status, 'disabled')))
      .orderBy(asc(users.name))
    if (scope.member.role === 'admin') return rows
    return rows.map(({ email: _email, ...row }) => row)
  }
}

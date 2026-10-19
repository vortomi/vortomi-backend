import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { MemberRole, PlatformRole, TenantStatus } from '../../db/schema/enums.ts'
import { memberships, tenants, users } from '../../db/schema/index.ts'

export interface AccountRecord {
  id: string
  email: string
  name: string
  platformRole: PlatformRole | null
}

export interface CompanyAccess {
  tenantId: string
  name: string
  tenantStatus: TenantStatus
  role: MemberRole
}

/**
 * Platform-level lookups about the caller, before any company is chosen (like the
 * channel directory routes Meta events). Runs as the server role, so every query
 * here is keyed by the VERIFIED user id and returns that person's rows only.
 */
export class AccessDirectory {
  constructor(private readonly db: Database) {}

  async findAccount(userId: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name, platformRole: users.platformRole })
      .from(users)
      .where(eq(users.id, userId))
    return row ?? null
  }

  /** The companies this person can enter right now (active memberships only). */
  async companiesOf(userId: string): Promise<CompanyAccess[]> {
    return this.db
      .select({ tenantId: tenants.id, name: tenants.name, tenantStatus: tenants.status, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
      .orderBy(asc(tenants.name))
  }
}

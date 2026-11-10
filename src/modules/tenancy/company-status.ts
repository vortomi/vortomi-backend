import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { tenants } from '../../db/schema/index.ts'
import { withTenant } from './tenant-scope.ts'

/**
 * Whether a company is working: active, not suspended (for example, unpaid) nor cancelled. Its
 * customers' messages are always stored; only a working company answers them by itself.
 */
export const companyIsActive =
  (db: Database) =>
  (tenantId: string): Promise<boolean> =>
    withTenant(db, tenantId, async ({ tx }) => {
      const [company] = await tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId))
      return company?.status === 'active'
    })

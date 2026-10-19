import { asc } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { tenants } from '../../db/schema/index.ts'

/**
 * The company list of the platform console. Server role, platform data only:
 * nothing here reads conversations, contacts or messages of any company.
 */
export class TenantCatalog {
  constructor(private readonly db: Database) {}

  list() {
    return this.db
      .select({ id: tenants.id, name: tenants.name, status: tenants.status, plan: tenants.plan, createdAt: tenants.createdAt })
      .from(tenants)
      .orderBy(asc(tenants.name))
  }
}

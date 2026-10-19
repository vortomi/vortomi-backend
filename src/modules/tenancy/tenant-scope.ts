import { sql } from 'drizzle-orm'
import type { Database, Transaction } from '../../db/client.ts'

declare const scopeBrand: unique symbol

/**
 * Proof that the code runs inside ONE company's transaction. Its brand cannot be
 * created outside this file, so every repository that takes a TenantScope can only
 * be called through withTenant(): there is no way to reach a company's rows
 * without saying whose they are (design document 8.8, first layer).
 */
export interface TenantScope {
  readonly tenantId: string
  readonly tx: Transaction
  readonly [scopeBrand]: true
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidTenantIdError extends Error {
  constructor() {
    super('Tenant id must be a UUID')
    this.name = 'InvalidTenantIdError'
  }
}

/**
 * Runs `work` in a transaction bound to one company, with the database enforcing it
 * too (second layer): the company id goes into app.tenant_id and the transaction
 * switches to the tenant_scoped role, which has no way around the RLS policies
 * (drizzle/0001_security_rls.sql). Both settings are LOCAL: they end with the
 * transaction and never leak to the next user of the pooled connection.
 */
export async function withTenant<T>(db: Database, tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new InvalidTenantIdError()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`set local role tenant_scoped`)
    return work({ tenantId, tx } as TenantScope)
  })
}

import { sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'

/**
 * The authenticator-app codes of our console admins. Supabase Auth keeps them (auth.mfa_factors),
 * never our tables; the console only needs to know who set one up and to start one over.
 */
export interface AuthenticatorFactors {
  /** Which of these people already set up their authenticator app. */
  withCode(userIds: string[]): Promise<Set<string>>
  /** Forgets the person's codes: on their next console visit they scan a new QR. */
  reset(userId: string): Promise<void>
}

/**
 * Reads and clears Supabase Auth's factors straight from its schema, through the server's own
 * connection (the database owner). Only totp factors exist in Vortomi (core/second-factor.ts).
 */
export class SupabaseAuthenticatorFactors implements AuthenticatorFactors {
  constructor(private readonly db: Database) {}

  async withCode(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set()
    const ids = sql.join(
      userIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )
    const result = await this.db.execute(
      sql`select distinct user_id::text as user_id from auth.mfa_factors where status = 'verified' and user_id in (${ids})`,
    )
    // postgres-js answers the rows; PGlite an object with them.
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { user_id: string }[]
    return new Set(rows.map((row) => row.user_id))
  }

  async reset(userId: string): Promise<void> {
    await this.db.execute(sql`delete from auth.mfa_factors where user_id = ${userId}::uuid`)
  }
}

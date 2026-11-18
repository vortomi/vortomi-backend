import { type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'

/** What Supabase Auth knows about a staff member's access (mockup web-28). */
export interface StaffAccount {
  lastSignInAt: Date | null
  /** When their authenticator code was set up, and when it was last asked for. */
  codeSince: Date | null
  codeLastUsedAt: Date | null
}

/** One signed-in device of a staff member, as Supabase Auth keeps it. */
export interface StaffSession {
  id: string
  userId: string
  userAgent: string | null
  ip: string | null
  createdAt: Date
  lastActiveAt: Date
}

/**
 * The staff's accounts and sessions, read from Supabase Auth (never our tables). Ending a session
 * stops it from being renewed; a token already given keeps working until it expires (one hour).
 */
export interface StaffAccounts {
  accounts(userIds: string[]): Promise<Map<string, StaffAccount>>
  sessions(userIds: string[]): Promise<StaffSession[]>
  /** True when that session was the person's and is now ended. */
  endSession(userId: string, sessionId: string): Promise<boolean>
  /** Every session of the person, except `keep` (the caller's own); how many ended. */
  endSessions(userId: string, keep?: string): Promise<number>
}

const asDate = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string))

/**
 * Supabase Auth's schema, read and changed through the server's own connection (the database
 * owner), as SupabaseAuthenticatorFactors does. Live sessions: not past their end (not_after).
 */
export class SupabaseStaffAccounts implements StaffAccounts {
  constructor(private readonly db: Database) {}

  async accounts(userIds: string[]): Promise<Map<string, StaffAccount>> {
    if (!userIds.length) return new Map()
    const rows = await this.rows<{ id: string; last_sign_in_at: unknown; code_since: unknown; code_used: unknown }>(sql`
      select u.id::text as id, u.last_sign_in_at,
        (select min(f.created_at) from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as code_since,
        (select max(f.last_challenged_at) from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as code_used
      from auth.users u where u.id in (${ids(userIds)})`)
    return new Map(rows.map((r) => [r.id, { lastSignInAt: asDate(r.last_sign_in_at), codeSince: asDate(r.code_since), codeLastUsedAt: asDate(r.code_used) }]))
  }

  async sessions(userIds: string[]): Promise<StaffSession[]> {
    if (!userIds.length) return []
    const rows = await this.rows<{ id: string; user_id: string; user_agent: string | null; ip: string | null; created_at: unknown; active_at: unknown }>(sql`
      select s.id::text as id, s.user_id::text as user_id, s.user_agent, host(s.ip) as ip, s.created_at,
        coalesce(s.refreshed_at, s.updated_at, s.created_at) as active_at
      from auth.sessions s
      where s.user_id in (${ids(userIds)}) and (s.not_after is null or s.not_after > now())
      order by active_at desc`)
    return rows.map((r) => ({ id: r.id, userId: r.user_id, userAgent: r.user_agent, ip: r.ip, createdAt: new Date(r.created_at as string), lastActiveAt: new Date(r.active_at as string) }))
  }

  async endSession(userId: string, sessionId: string): Promise<boolean> {
    const rows = await this.rows<{ id: string }>(sql`delete from auth.sessions where id = ${sessionId}::uuid and user_id = ${userId}::uuid returning id::text as id`)
    return rows.length > 0
  }

  async endSessions(userId: string, keep?: string): Promise<number> {
    const rows = await this.rows<{ id: string }>(
      keep
        ? sql`delete from auth.sessions where user_id = ${userId}::uuid and id <> ${keep}::uuid returning id::text as id`
        : sql`delete from auth.sessions where user_id = ${userId}::uuid returning id::text as id`,
    )
    return rows.length
  }

  private async rows<T>(query: SQL): Promise<T[]> {
    const result = await this.db.execute(query)
    // postgres-js answers the rows; PGlite an object with them.
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[]
  }
}

const ids = (userIds: string[]) =>
  sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

/** «Chrome», «Safari»…: the browser a user agent names (the common ones; anything else «Navegador»). */
export function browserOf(userAgent: string | null): string {
  const ua = userAgent ?? ''
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'Navegador'
}

/** «Windows», «iPhone»…: the system a user agent names. */
export function systemOf(userAgent: string | null): { name: string; mobile: boolean } {
  const ua = userAgent ?? ''
  if (/iPhone|iPad/.test(ua)) return { name: /iPad/.test(ua) ? 'iPad' : 'iPhone', mobile: true }
  if (/Android/.test(ua)) return { name: 'Android', mobile: true }
  if (/Windows/.test(ua)) return { name: 'Windows', mobile: false }
  if (/Mac OS X|Macintosh/.test(ua)) return { name: 'macOS', mobile: false }
  if (/Linux/.test(ua)) return { name: 'Linux', mobile: false }
  return { name: 'otro sistema', mobile: false }
}

/** An address with its last part hidden: «190.205.x.x», «2800:e2::…». Never the whole of it. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null
  if (ip.includes('.')) {
    const parts = ip.split('.')
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : null
  }
  const groups = ip.split(':').filter(Boolean)
  return groups.length >= 2 ? `${groups[0]}:${groups[1]}::…` : null
}

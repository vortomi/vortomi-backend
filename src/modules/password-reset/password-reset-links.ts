import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { memberships, passwordResets, tenants, users } from '../../db/schema/index.ts'
import type { StaffAccounts } from '../platform/staff-accounts.ts'
import { hashOf, newToken } from '../team/invitation-token.ts'
import { type AccountPasswords, unknownPassword } from './account-passwords.ts'

/** How long a password link works (mockup web-30): one day, once. */
export const RESET_TTL_MS = 24 * 3_600_000

/** Not a link of ours, already used or replaced by a newer one. */
export class ResetNotFoundError extends Error {
  constructor() {
    super('Password link not found, already used or replaced')
    this.name = 'ResetNotFoundError'
  }
}

export class ResetExpiredError extends Error {
  constructor() {
    super('Password link expired')
    this.name = 'ResetExpiredError'
  }
}

/** The server has no Supabase secret key (SUPABASE_SECRET_KEY): it cannot set passwords. */
export class ResetUnavailableError extends Error {
  constructor() {
    super('Passwords cannot be set from this server')
    this.name = 'ResetUnavailableError'
  }
}

export interface IssuedReset {
  token: string
  expiresAt: Date
  name: string
}

/** Sessions of anyone in Supabase Auth (the staff's port reads and ends them for everyone alike). */
export type AuthSessions = Pick<StaffAccounts, 'endSessions'>

const open = and(isNull(passwordResets.usedAt), isNull(passwordResets.revokedAt))

/**
 * The one-time link itself (mockup web-30), whoever gives it: the rules of who may give one to whom
 * live with each giver (CompanyPasswordResets, PlatformTeamService). Server role only.
 *
 * Giving a link makes the old password stop working and signs the person out everywhere, so a link
 * given because an account was taken over closes it at once. Using it sets the password the person
 * chose, which nobody else ever sees, and signs them out again of anything opened meanwhile.
 */
export class PasswordResetLinks {
  constructor(
    private readonly db: Database,
    private readonly passwords: AccountPasswords | null,
    private readonly sessions: AuthSessions,
  ) {}

  /** Whether this server can set passwords at all. */
  get available(): boolean {
    return this.passwords !== null
  }

  async issue(input: { userId: string; createdBy: string; tenantId: string | null }): Promise<IssuedReset> {
    const passwords = this.requirePasswords()
    const token = newToken()
    const expiresAt = new Date(Date.now() + RESET_TTL_MS)
    const name = await this.db.transaction(async (tx) => {
      // A newer link replaces any the person still had.
      await tx.update(passwordResets).set({ revokedAt: sql`now()` }).where(and(eq(passwordResets.userId, input.userId), open))
      await tx.insert(passwordResets).values({ ...input, tokenHash: hashOf(token), expiresAt })
      const [person] = await tx.select({ name: users.name }).from(users).where(eq(users.id, input.userId))
      return person?.name ?? ''
    })
    await passwords.set(input.userId, unknownPassword())
    await this.sessions.endSessions(input.userId)
    return { token, expiresAt, name }
  }

  /** What the page shows before the person chooses: who they are, who gave it and for which company. */
  async preview(token: string) {
    const giver = sql<string | null>`(select g.name from ${users} g where g.id = ${passwordResets.createdBy}
      and (${passwordResets.tenantId} is null or exists (select 1 from ${memberships} gm where gm.user_id = g.id and gm.tenant_id = ${passwordResets.tenantId})))`
    const [row] = await this.db
      .select({
        name: users.name,
        // Someone of the company or of our staff; when the console gave it for a company: «Vortomi».
        givenBy: giver,
        companyName: tenants.name,
        staff: sql<boolean>`${users.platformRole} = 'super_admin'`,
        expiresAt: passwordResets.expiresAt,
      })
      .from(passwordResets)
      .innerJoin(users, eq(users.id, passwordResets.userId))
      .leftJoin(tenants, eq(tenants.id, passwordResets.tenantId))
      .where(and(eq(passwordResets.tokenHash, hashOf(token)), open))
    if (!row) throw new ResetNotFoundError()
    if (row.expiresAt.getTime() < Date.now()) throw new ResetExpiredError()
    return { ...row, staff: row.staff === true }
  }

  /**
   * Sets the chosen password and spends the link. The row stays locked until Supabase answered, so
   * the same link used twice at once sets one password and the second gets «not found».
   * The email comes back so the page can sign the person in with it.
   */
  async complete(token: string, password: string): Promise<{ email: string }> {
    const passwords = this.requirePasswords()
    const result = await this.db.transaction(async (tx) => {
      const [link] = await tx
        .select({ id: passwordResets.id, userId: passwordResets.userId, expiresAt: passwordResets.expiresAt })
        .from(passwordResets)
        .where(and(eq(passwordResets.tokenHash, hashOf(token)), open))
        .for('update')
      if (!link) throw new ResetNotFoundError()
      if (link.expiresAt.getTime() < Date.now()) throw new ResetExpiredError()
      await passwords.set(link.userId, password)
      await tx.update(passwordResets).set({ usedAt: sql`now()` }).where(eq(passwordResets.id, link.id))
      const [person] = await tx.select({ email: users.email }).from(users).where(eq(users.id, link.userId))
      return { userId: link.userId, email: person?.email ?? '' }
    })
    await this.sessions.endSessions(result.userId)
    return { email: result.email }
  }

  private requirePasswords(): AccountPasswords {
    if (!this.passwords) throw new ResetUnavailableError()
    return this.passwords
  }
}

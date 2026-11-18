import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { type PlatformTeamAction, platformActivity, platformInvitations, platformTeamEvents, users } from '../../db/schema/index.ts'
import type { VerifiedIdentity } from '../access/identity.ts'
import { InvitationEmailMismatchError, InvitationExpiredError, InvitationNotFoundError } from '../team/invitation-service.ts'
import { hashOf, invitationExpiry, newToken } from '../team/invitation-token.ts'
import type { AuthenticatorFactors } from './authenticator-factors.ts'
import { type StaffAccount, type StaffAccounts, type StaffSession, browserOf, maskIp, systemOf } from './staff-accounts.ts'

/** That person already enters the console. */
export class AlreadyPlatformAdminError extends Error {
  constructor() {
    super('That person is already a platform admin')
    this.name = 'AlreadyPlatformAdminError'
  }
}

/** Not one of the console's admins (or already removed). */
export class PlatformAdminNotFoundError extends Error {
  constructor() {
    super('Not a platform admin')
    this.name = 'PlatformAdminNotFoundError'
  }
}

/** Nobody removes themselves or resets their own code from here: the console never ends up without anyone. */
export class NotOnYourselfError extends Error {
  constructor() {
    super('This cannot be done on yourself')
    this.name = 'NotOnYourselfError'
  }
}

export const platformInvitationInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().transform((email) => email.trim().toLowerCase()),
})
export type PlatformInvitationInput = z.infer<typeof platformInvitationInput>

const open = and(isNull(platformInvitations.acceptedAt), isNull(platformInvitations.revokedAt))
const invitationColumns = { id: platformInvitations.id, name: platformInvitations.name, email: platformInvitations.email, expiresAt: platformInvitations.expiresAt }
/** How much of the team's history the console shows. */
const HISTORY = 30
/** How much of the console's activity the staff page shows. */
const ACTIVITY = 60

/** That session is not one of that person's (or already ended). */
export class StaffSessionNotFoundError extends Error {
  constructor() {
    super('No such session')
    this.name = 'StaffSessionNotFoundError'
  }
}

/**
 * Who enters our console (mockup web-22): the platform admins, their invitations, their
 * authenticator codes and the history of all of it. Server role only, behind the console's own
 * check (super admin with the second factor). Each person has their own code on their own phone.
 */
export class PlatformTeamService {
  constructor(
    private readonly db: Database,
    private readonly factors: AuthenticatorFactors,
    // Last access, code dates and devices (Supabase Auth); without it the page shows only the list.
    private readonly staff: StaffAccounts | null = null,
  ) {}

  /**
   * The staff page (mockup web-28): who has access and how safely (code, last access, devices),
   * open invitations, the team's history and the console's activity on companies. IPs leave the
   * server with their last part hidden; tokens and typed data are never kept, so never shown.
   */
  async overview(viewer: { userId: string; sessionId?: string }) {
    const inviter = alias(users, 'inviter')
    const [admins, invitations, events, activity] = await Promise.all([
      this.db
        .select({
          userId: users.id,
          name: users.name,
          email: users.email,
          createdAt: users.createdAt,
          // Who invited them (none for the first admins, made by hand).
          invitedBy: sql<string | null>`(select i.name from ${platformInvitations} p join ${users} i on i.id = p.invited_by
            where p.accepted_by = ${users}.id order by p.accepted_at desc limit 1)`,
        })
        .from(users)
        .where(eq(users.platformRole, 'super_admin'))
        .orderBy(asc(users.name)),
      this.db
        .select({ ...invitationColumns, createdAt: platformInvitations.createdAt, invitedBy: inviter.name })
        .from(platformInvitations)
        .innerJoin(inviter, eq(inviter.id, platformInvitations.invitedBy))
        .where(open)
        .orderBy(asc(platformInvitations.createdAt)),
      this.db
        .select({
          action: platformTeamEvents.action,
          actorName: users.name,
          subjectEmail: platformTeamEvents.subjectEmail,
          subjectName: sql<string | null>`(select s.name from ${users} s where s.email = ${platformTeamEvents}.subject_email limit 1)`,
          createdAt: platformTeamEvents.createdAt,
        })
        .from(platformTeamEvents)
        .innerJoin(users, eq(users.id, platformTeamEvents.actorUserId))
        .orderBy(desc(platformTeamEvents.createdAt), desc(platformTeamEvents.id))
        .limit(HISTORY),
      this.db
        .select({ action: platformActivity.action, actorUserId: platformActivity.actorUserId, actorName: users.name, tenantId: platformActivity.tenantId, tenantName: platformActivity.tenantName, createdAt: platformActivity.createdAt })
        .from(platformActivity)
        .innerJoin(users, eq(users.id, platformActivity.actorUserId))
        .orderBy(desc(platformActivity.createdAt), desc(platformActivity.id))
        .limit(ACTIVITY),
    ])
    const ids = admins.map((a) => a.userId)
    const [withCode, accounts, sessions] = await Promise.all([
      this.factors.withCode(ids),
      this.staff?.accounts(ids) ?? Promise.resolve(new Map<string, StaffAccount>()),
      this.staff?.sessions(ids) ?? Promise.resolve<StaffSession[]>([]),
    ])
    const nameOf = new Map(admins.map((a) => [a.userId, a.name]))
    return {
      admins: admins.map((a) => {
        const account = accounts.get(a.userId)
        return {
          ...a,
          hasCode: withCode.has(a.userId),
          isYou: a.userId === viewer.userId,
          lastSignInAt: account?.lastSignInAt ?? null,
          codeSince: account?.codeSince ?? null,
          codeLastUsedAt: account?.codeLastUsedAt ?? null,
          sessionCount: sessions.filter((s) => s.userId === a.userId).length,
          lastActionAt: activity.find((entry) => entry.actorUserId === a.userId)?.createdAt ?? null,
        }
      }),
      invitations,
      sessions: sessions.map((s) => {
        const system = systemOf(s.userAgent)
        return {
          id: s.id,
          userId: s.userId,
          name: nameOf.get(s.userId) ?? '',
          browser: browserOf(s.userAgent),
          system: system.name,
          mobile: system.mobile,
          ip: maskIp(s.ip),
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          current: s.id === viewer.sessionId,
        }
      }),
      events,
      activity,
    }
  }

  /** One device of a staff member signed out (a lost laptop). Never the caller's own current session. */
  async endSession(actor: { userId: string; sessionId?: string }, userId: string, sessionId: string): Promise<void> {
    if (sessionId === actor.sessionId) throw new NotOnYourselfError()
    const admin = await this.admin(userId)
    if (!(await this.staff?.endSession(userId, sessionId))) throw new StaffSessionNotFoundError()
    await this.record(this.db, actor.userId, 'admin.session_ended', admin.email)
  }

  /** Every device of another staff member signed out (a lost phone). Their access and code stay. */
  async endSessions(actorId: string, userId: string): Promise<{ ended: number }> {
    const admin = await this.otherAdmin(actorId, userId)
    const ended = (await this.staff?.endSessions(userId)) ?? 0
    await this.record(this.db, actorId, 'admin.sessions_ended', admin.email)
    return { ended }
  }

  /** The link comes back once; only its hash is kept. */
  async invite(actorId: string, input: PlatformInvitationInput) {
    const [already] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.email, input.email), eq(users.platformRole, 'super_admin')))
    if (already) throw new AlreadyPlatformAdminError()
    return this.db.transaction(async (tx) => {
      const token = newToken()
      const [row] = await tx
        .insert(platformInvitations)
        .values({ ...input, tokenHash: hashOf(token), expiresAt: invitationExpiry(), invitedBy: actorId })
        .returning(invitationColumns)
      await this.record(tx, actorId, 'admin.invited', input.email)
      return { ...row!, token }
    })
  }

  /** A new link: the old one stops working. */
  async renew(actorId: string, invitationId: string) {
    return this.db.transaction(async (tx) => {
      const token = newToken()
      const [row] = await tx
        .update(platformInvitations)
        .set({ tokenHash: hashOf(token), expiresAt: invitationExpiry() })
        .where(and(eq(platformInvitations.id, invitationId), open))
        .returning(invitationColumns)
      if (!row) throw new InvitationNotFoundError()
      await this.record(tx, actorId, 'admin.invitation_renewed', row.email)
      return { ...row, token }
    })
  }

  async revoke(actorId: string, invitationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(platformInvitations)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(platformInvitations.id, invitationId), open))
        .returning({ email: platformInvitations.email })
      if (!row) throw new InvitationNotFoundError()
      await this.record(tx, actorId, 'admin.invitation_revoked', row.email)
    })
  }

  /** What the invitation page shows, without a session. The token itself is the secret. */
  async preview(token: string) {
    const [row] = await this.db
      .select({
        email: platformInvitations.email,
        name: platformInvitations.name,
        expiresAt: platformInvitations.expiresAt,
        hasAccount: sql<boolean>`exists (select 1 from ${users} u where u.email = ${platformInvitations.email})`,
      })
      .from(platformInvitations)
      .where(and(eq(platformInvitations.tokenHash, hashOf(token)), open))
    if (!row) throw new InvitationNotFoundError()
    if (row.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError()
    return row
  }

  /**
   * The signed-in person becomes a platform admin. Only with the email it was sent to; a link works
   * once. Their authenticator code is set up on their first visit to the console (aal2 is demanded).
   */
  async accept(identity: VerifiedIdentity, token: string, name?: string): Promise<{ platform: true }> {
    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(platformInvitations)
        .where(and(eq(platformInvitations.tokenHash, hashOf(token)), open))
        .for('update')
      if (!invitation) throw new InvitationNotFoundError()
      if (invitation.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError()
      if (identity.email.trim().toLowerCase() !== invitation.email) throw new InvitationEmailMismatchError()

      await tx.insert(users).values({ id: identity.userId, email: invitation.email, name: name ?? invitation.name }).onConflictDoNothing({ target: users.id })
      await tx.update(users).set({ platformRole: 'super_admin' }).where(eq(users.id, identity.userId))
      await tx.update(platformInvitations).set({ acceptedAt: sql`now()`, acceptedBy: identity.userId }).where(eq(platformInvitations.id, invitation.id))
      await this.record(tx, identity.userId, 'admin.joined', invitation.email)
      return { platform: true as const }
    })
  }

  /** Lost phone: their codes are forgotten; on their next console visit they scan a new QR. Access stays. */
  async resetCode(actorId: string, userId: string): Promise<void> {
    const admin = await this.otherAdmin(actorId, userId)
    await this.factors.reset(userId)
    await this.record(this.db, actorId, 'admin.code_reset', admin.email)
  }

  /** They stop entering the console at once (every request checks the role). Company memberships stay. */
  async remove(actorId: string, userId: string): Promise<void> {
    const admin = await this.otherAdmin(actorId, userId)
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ platformRole: null }).where(and(eq(users.id, userId), eq(users.platformRole, 'super_admin')))
      await this.record(tx, actorId, 'admin.removed', admin.email)
    })
  }

  /** Never on oneself: the one acting stays, so the console always keeps at least one admin. */
  private async otherAdmin(actorId: string, userId: string) {
    if (actorId === userId) throw new NotOnYourselfError()
    return this.admin(userId)
  }

  private async admin(userId: string) {
    const [admin] = await this.db.select({ email: users.email }).from(users).where(and(eq(users.id, userId), eq(users.platformRole, 'super_admin')))
    if (!admin) throw new PlatformAdminNotFoundError()
    return admin
  }

  private async record(exec: Executor, actorUserId: string, action: PlatformTeamAction, subjectEmail: string): Promise<void> {
    await exec.insert(platformTeamEvents).values({ actorUserId, action, subjectEmail })
  }
}

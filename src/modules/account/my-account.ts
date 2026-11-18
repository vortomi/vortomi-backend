import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { memberships, platformActivity, platformInvitations, platformTeamEvents, tenants, users } from '../../db/schema/index.ts'
import { alias } from 'drizzle-orm/pg-core'
import type { VerifiedIdentity } from '../access/identity.ts'
import { NotOnYourselfError, StaffSessionNotFoundError } from '../platform/platform-team-service.ts'
import { type StaffAccounts, browserOf, maskIp, systemOf } from '../platform/staff-accounts.ts'

/** The token says no session: «close the others» cannot know which one to keep. */
export class SessionUnknownError extends Error {
  constructor() {
    super('The access token names no session')
    this.name = 'SessionUnknownError'
  }
}

export const nameInput = z.object({ name: z.string().trim().min(1).max(80) })

/** How much of one's own console activity the profile shows. */
const RECENT = 8

/**
 * «Mi perfil» (mockup web-29): one's own account, for anyone signed in. Who they are and since when,
 * their code and last access (Supabase Auth), their open devices (IPs half hidden), their companies,
 * and, for our staff, their own last changes in the console. They can sign their other devices out;
 * never the one they are using.
 */
export class MyAccount {
  constructor(
    private readonly db: Database,
    private readonly auth: StaffAccounts,
  ) {}

  async profile(identity: VerifiedIdentity, account: { name: string; email: string; platformRole: string | null }) {
    const userId = identity.userId
    const staff = account.platformRole === 'super_admin'
    const inviter = alias(users, 'inviter')
    const [[user], companies, accounts, sessions, invitedBy, activity] = await Promise.all([
      this.db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)),
      this.db
        .select({ tenantId: tenants.id, name: tenants.name, role: memberships.role, since: memberships.createdAt })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
        .orderBy(asc(tenants.name)),
      this.auth.accounts([userId]),
      this.auth.sessions([userId]),
      staff
        ? this.db
            .select({ name: inviter.name })
            .from(platformInvitations)
            .innerJoin(inviter, eq(inviter.id, platformInvitations.invitedBy))
            .where(eq(platformInvitations.acceptedBy, userId))
            .orderBy(desc(platformInvitations.acceptedAt))
            .limit(1)
        : Promise.resolve([]),
      staff ? this.recentActivity(userId) : Promise.resolve([]),
    ])
    const auth = accounts.get(userId)
    return {
      name: account.name,
      email: account.email,
      staff,
      memberSince: user?.createdAt ?? null,
      invitedBy: invitedBy[0]?.name ?? null,
      lastSignInAt: auth?.lastSignInAt ?? null,
      code: auth?.codeSince ? { since: auth.codeSince, lastUsedAt: auth.codeLastUsedAt } : null,
      companies,
      sessions: sessions.map((s) => {
        const system = systemOf(s.userAgent)
        return { id: s.id, browser: browserOf(s.userAgent), system: system.name, mobile: system.mobile, ip: maskIp(s.ip), createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, current: s.id === identity.sessionId }
      }),
      activity,
    }
  }

  async rename(userId: string, name: string): Promise<{ name: string }> {
    await this.db.update(users).set({ name }).where(eq(users.id, userId))
    return { name }
  }

  /** One of one's own devices, never the one in use. */
  async endSession(identity: VerifiedIdentity, sessionId: string): Promise<void> {
    if (sessionId === identity.sessionId) throw new NotOnYourselfError()
    if (!(await this.auth.endSession(identity.userId, sessionId))) throw new StaffSessionNotFoundError()
  }

  /** Every other device: after a password change, or a session left open somewhere. */
  async endOtherSessions(identity: VerifiedIdentity): Promise<{ ended: number }> {
    if (!identity.sessionId) throw new SessionUnknownError()
    return { ended: await this.auth.endSessions(identity.userId, identity.sessionId) }
  }

  /** Their own console changes and staff actions, newest first, as one list. */
  private async recentActivity(userId: string) {
    const subject = alias(users, 'subject')
    const [console_, team] = await Promise.all([
      this.db
        .select({ action: platformActivity.action, target: platformActivity.tenantName, createdAt: platformActivity.createdAt })
        .from(platformActivity)
        .where(eq(platformActivity.actorUserId, userId))
        .orderBy(desc(platformActivity.createdAt))
        .limit(RECENT),
      this.db
        .select({ action: platformTeamEvents.action, target: subject.name, email: platformTeamEvents.subjectEmail, createdAt: platformTeamEvents.createdAt })
        .from(platformTeamEvents)
        .leftJoin(subject, eq(subject.email, platformTeamEvents.subjectEmail))
        .where(eq(platformTeamEvents.actorUserId, userId))
        .orderBy(desc(platformTeamEvents.createdAt))
        .limit(RECENT),
    ])
    return [...console_.map((c) => ({ action: c.action, target: c.target, createdAt: c.createdAt })), ...team.map((t) => ({ action: t.action, target: t.target ?? t.email, createdAt: t.createdAt }))]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, RECENT)
  }
}

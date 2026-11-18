import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Database } from '../../db/client.ts'
import { invitations, memberships, passwordResets, users } from '../../db/schema/index.ts'
import type { StaffAccounts } from '../platform/staff-accounts.ts'
import { MemberNotFoundError } from '../team/team-service.ts'
import type { IssuedReset, PasswordResetLinks } from './password-reset-links.ts'

/** Only the company's owner gives their staff password links; other admins see the option off. */
export class OwnerRequiredError extends Error {
  constructor() {
    super('Only the owner of the company can do this')
    this.name = 'OwnerRequiredError'
  }
}

/**
 * The person also works in another company: their account is one for all of them, so a company
 * that could reset it would get into the other one too. Only Vortomi does it.
 */
export class MemberElsewhereError extends Error {
  constructor() {
    super('That person also works in another company')
    this.name = 'MemberElsewhereError'
  }
}

/** Our own staff's password is only reset by the staff, from the console. */
export class StaffMemberError extends Error {
  constructor() {
    super('That person is part of the Vortomi staff')
    this.name = 'StaffMemberError'
  }
}

/** Nobody gives themselves a link: they would not need one if they could sign in. */
export class OwnResetError extends Error {
  constructor() {
    super('A link is not given to oneself')
    this.name = 'OwnResetError'
  }
}

/** The new owner must be an active admin of the company. */
export class OwnerNotAdminError extends Error {
  constructor() {
    super('The owner must be an active admin of the company')
    this.name = 'OwnerNotAdminError'
  }
}

/** An admin of the company, as the route proved it (asAdmin). */
export interface CompanyAdmin {
  tenantId: string
  userId: string
}

export type ResetBlock = 'self' | 'elsewhere' | 'staff' | 'inactive'

/** How much of the team's history the company sees. */
const HISTORY = 20

/**
 * Password links inside a company (mockup web-30). The owner gives them to the people who work only
 * in their company; the console to anyone of any company, and it also hands the company to a new owner.
 * The route proves the caller is an admin of the company (its RLS scope, then closed); everything here
 * runs on the server's connection, always filtered by that company: links and other companies are
 * platform data, and one request never holds two connections. Only what the owner's screen needs comes back.
 */
export class CompanyPasswordResets {
  constructor(
    private readonly db: Database,
    private readonly links: PasswordResetLinks,
    private readonly accounts: Pick<StaffAccounts, 'accounts'>,
  ) {}

  /** For the team table (admins): who is the owner, each person's last access and whether a link can be given. */
  async access(admin: CompanyAdmin) {
    const people = await this.db
      .select({ userId: memberships.userId, status: memberships.status, isOwner: memberships.isOwner })
      .from(memberships)
      .where(eq(memberships.tenantId, admin.tenantId))
    const ids = people.map((p) => p.userId)
    const [elsewhere, staff, accounts, history] = await Promise.all([
      this.elsewhere(admin.tenantId, ids),
      this.staff(ids),
      this.accounts.accounts(ids),
      this.history(admin.tenantId),
    ])
    const youAreOwner = people.some((p) => p.userId === admin.userId && p.isOwner)
    return {
      youAreOwner,
      available: this.links.available,
      people: people.map((p) => ({
        userId: p.userId,
        isOwner: p.isOwner,
        lastSignInAt: accounts.get(p.userId)?.lastSignInAt ?? null,
        elsewhere: elsewhere.has(p.userId),
        blocked: this.block(admin.userId, p.userId, p.status, elsewhere, staff),
      })),
      history,
    }
  }

  /** The owner gives a link to someone who works only in this company. */
  async issueAsOwner(admin: CompanyAdmin, userId: string): Promise<IssuedReset> {
    const [rows, elsewhere, staff] = await Promise.all([
      this.db
        .select({ userId: memberships.userId, status: memberships.status, isOwner: memberships.isOwner })
        .from(memberships)
        .where(and(eq(memberships.tenantId, admin.tenantId), inArray(memberships.userId, [admin.userId, userId]))),
      this.elsewhere(admin.tenantId, [userId]),
      this.staff([userId]),
    ])
    if (!rows.some((r) => r.userId === admin.userId && r.isOwner)) throw new OwnerRequiredError()
    const target = rows.find((r) => r.userId === userId)
    if (!target) throw new MemberNotFoundError()
    const blocked = this.block(admin.userId, userId, target.status, elsewhere, staff)
    if (blocked === 'self') throw new OwnResetError()
    if (blocked === 'staff') throw new StaffMemberError()
    if (blocked === 'elsewhere') throw new MemberElsewhereError()
    if (blocked === 'inactive') throw new MemberNotFoundError()
    return this.links.issue({ userId, createdBy: admin.userId, tenantId: admin.tenantId })
  }

  /** The console, for anyone active in the company: owners, admins, people of several companies. */
  async issueAsConsole(actorId: string, tenantId: string, userId: string): Promise<IssuedReset> {
    if (actorId === userId) throw new OwnResetError()
    const [member] = await this.db
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    if (member?.status !== 'active') throw new MemberNotFoundError()
    return this.links.issue({ userId, createdBy: actorId, tenantId })
  }

  /** «Hacer dueño a otra persona»: when the company changes hands. The previous owner stays an admin. */
  async transferOwner(tenantId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .for('update')
      if (target?.role !== 'admin' || target.status !== 'active') throw new OwnerNotAdminError()
      // One owner per company (unique index): the old one first.
      await tx.update(memberships).set({ isOwner: false }).where(and(eq(memberships.tenantId, tenantId), eq(memberships.isOwner, true)))
      await tx.update(memberships).set({ isOwner: true }).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    })
  }

  private block(viewerId: string, userId: string, status: string, elsewhere: Set<string>, staff: Set<string>): ResetBlock | null {
    if (userId === viewerId) return 'self'
    if (staff.has(userId)) return 'staff'
    if (elsewhere.has(userId)) return 'elsewhere'
    if (status !== 'active') return 'inactive'
    return null
  }

  /** Who of these people has a place (any status) in another company. */
  private async elsewhere(tenantId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set()
    const rows = await this.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .where(and(inArray(memberships.userId, userIds), ne(memberships.tenantId, tenantId)))
    return new Set(rows.map((r) => r.userId))
  }

  private async staff(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set()
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.platformRole, 'super_admin')))
    return new Set(rows.map((r) => r.id))
  }

  /**
   * «Historial del equipo»: links given and used, invitations sent and accepted, newest first.
   * Whoever is not in the company (our console) is named «Vortomi» (actor null).
   */
  private async history(tenantId: string) {
    const subject = alias(users, 'subject')
    const actorName = (actorId: typeof passwordResets.createdBy | typeof invitations.invitedBy) =>
      sql<string | null>`(select a.name from ${users} a where a.id = ${actorId}
        and exists (select 1 from ${memberships} am where am.user_id = a.id and am.tenant_id = ${tenantId}::uuid))`
    const [resets, invited] = await Promise.all([
      this.db
        .select({ actor: actorName(passwordResets.createdBy), subject: subject.name, createdAt: passwordResets.createdAt, usedAt: passwordResets.usedAt })
        .from(passwordResets)
        .innerJoin(subject, eq(subject.id, passwordResets.userId))
        .where(eq(passwordResets.tenantId, tenantId))
        .orderBy(desc(passwordResets.createdAt))
        .limit(HISTORY),
      this.db
        .select({ actor: actorName(invitations.invitedBy), subject: invitations.name, createdAt: invitations.createdAt, acceptedAt: invitations.acceptedAt })
        .from(invitations)
        .where(and(eq(invitations.tenantId, tenantId), isNotNull(invitations.invitedBy)))
        .orderBy(desc(invitations.createdAt))
        .limit(HISTORY),
    ])
    const events = [
      ...resets.flatMap((r) => [
        { kind: 'reset_given' as const, actor: r.actor, subject: r.subject, at: r.createdAt },
        ...(r.usedAt ? [{ kind: 'reset_used' as const, actor: r.subject, subject: r.subject, at: r.usedAt }] : []),
      ]),
      ...invited.flatMap((i) => [
        { kind: 'invited' as const, actor: i.actor, subject: i.subject, at: i.createdAt },
        ...(i.acceptedAt ? [{ kind: 'joined' as const, actor: i.subject, subject: i.subject, at: i.acceptedAt }] : []),
      ]),
    ]
    return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, HISTORY)
  }
}

import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { MEMBER_ROLES } from '../../db/schema/enums.ts'
import { channelAccounts, invitations, membershipChannels, memberships, tenants, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { VerifiedIdentity } from '../access/identity.ts'

/** How long an invitation link works (documentations/03). */
const INVITATION_TTL_MS = 72 * 3_600_000

export class InvitationNotFoundError extends Error {
  constructor() {
    super('Invitation not found, already used or revoked')
    this.name = 'InvitationNotFoundError'
  }
}

export class InvitationExpiredError extends Error {
  constructor() {
    super('Invitation link expired')
    this.name = 'InvitationExpiredError'
  }
}

export class InvitationEmailMismatchError extends Error {
  constructor() {
    super('Signed in with an email the invitation was not sent to')
    this.name = 'InvitationEmailMismatchError'
  }
}

export class AlreadyMemberError extends Error {
  constructor() {
    super('That person is already in the company')
    this.name = 'AlreadyMemberError'
  }
}

export class UnknownChannelError extends Error {
  constructor() {
    super('A number is not of this company')
    this.name = 'UnknownChannelError'
  }
}

export const invitationInput = z.object({
  email: z.email().transform((email) => email.trim().toLowerCase()),
  name: z.string().trim().min(1).max(80),
  role: z.enum(MEMBER_ROLES),
  canSeeOthers: z.boolean().default(false),
  channelAccountIds: z.array(z.uuid()).max(50).default([]),
})
export type InvitationInput = z.infer<typeof invitationInput>

/** The link token: 256 random bits. Only its hash is stored. */
const newToken = () => randomBytes(32).toString('base64url')
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const expiry = () => new Date(Date.now() + INVITATION_TTL_MS)

const listColumns = {
  id: invitations.id,
  email: invitations.email,
  name: invitations.name,
  role: invitations.role,
  canSeeOthers: invitations.canSeeOthers,
  channelAccountIds: invitations.channelAccountIds,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
}

const open = and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt))

/**
 * Inviting people into a company. Admins create, renew and revoke them inside their company
 * (MemberScope, under RLS). Seeing and accepting one is done with the link token by someone
 * who is not a member yet, so those two run on the server's own connection.
 */
export class InvitationService {
  constructor(private readonly db: Database) {}

  list(scope: MemberScope) {
    return scope.tx
      .select(listColumns)
      .from(invitations)
      .where(and(eq(invitations.tenantId, scope.tenantId), open))
      .orderBy(asc(invitations.createdAt))
  }

  /** The token comes back only here and on renew: it is what the link carries. */
  async create(scope: MemberScope, input: InvitationInput) {
    const { tx, tenantId } = scope
    const [member] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(users.email, input.email)))
    if (member?.status === 'active') throw new AlreadyMemberError()
    await this.assertChannels(scope, input.channelAccountIds)

    const token = newToken()
    const [row] = await tx
      .insert(invitations)
      .values({
        tenantId,
        ...input,
        // Admins always see every conversation of their company.
        canSeeOthers: input.role === 'admin' || input.canSeeOthers,
        tokenHash: hashOf(token),
        expiresAt: expiry(),
        invitedBy: scope.member.userId,
      })
      .returning(listColumns)
    return { ...row!, token }
  }

  /** A fresh link and 72 more hours; the old link stops working. */
  async renew(scope: MemberScope, id: string) {
    const token = newToken()
    const [row] = await scope.tx
      .update(invitations)
      .set({ tokenHash: hashOf(token), expiresAt: expiry() })
      .where(and(eq(invitations.tenantId, scope.tenantId), eq(invitations.id, id), open))
      .returning(listColumns)
    if (!row) throw new InvitationNotFoundError()
    return { ...row, token }
  }

  async revoke(scope: MemberScope, id: string) {
    const revoked = await scope.tx
      .update(invitations)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invitations.tenantId, scope.tenantId), eq(invitations.id, id), open))
      .returning({ id: invitations.id })
    if (!revoked.length) throw new InvitationNotFoundError()
  }

  /** What the invitation page shows before the person signs in. */
  async preview(token: string) {
    const [row] = await this.db
      .select({
        companyName: tenants.name,
        email: invitations.email,
        name: invitations.name,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        hasAccount: sql<boolean>`exists (select 1 from ${users} u where u.email = ${invitations.email})`,
      })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(and(eq(invitations.tokenHash, hashOf(token)), open))
    if (!row) throw new InvitationNotFoundError()
    if (row.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError()
    return row
  }

  /**
   * The signed-in person joins the company with the role and numbers the invitation set.
   * Only with the email it was sent to; a link works once. Someone who was in the company
   * before (disabled) comes back with the new permissions.
   */
  async accept(identity: VerifiedIdentity, token: string, name?: string): Promise<{ tenantId: string }> {
    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.tokenHash, hashOf(token)), open))
        .for('update')
      if (!invitation) throw new InvitationNotFoundError()
      if (invitation.expiresAt.getTime() < Date.now()) throw new InvitationExpiredError()
      if (identity.email.trim().toLowerCase() !== invitation.email) throw new InvitationEmailMismatchError()

      const { tenantId } = invitation
      const userId = identity.userId
      // Someone who already has an account keeps their name; a new person gets the one they typed.
      await tx.insert(users).values({ id: userId, email: invitation.email, name: name ?? invitation.name }).onConflictDoNothing({ target: users.id })
      const membership = { role: invitation.role, status: 'active' as const, canSeeOthers: invitation.canSeeOthers }
      await tx
        .insert(memberships)
        .values({ tenantId, userId, ...membership })
        .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: membership })

      // Numbers removed since the invitation was sent are skipped.
      const channels = invitation.channelAccountIds.length
        ? await tx
            .select({ id: channelAccounts.id })
            .from(channelAccounts)
            .where(and(eq(channelAccounts.tenantId, tenantId), inArray(channelAccounts.id, invitation.channelAccountIds)))
        : []
      await tx.delete(membershipChannels).where(and(eq(membershipChannels.tenantId, tenantId), eq(membershipChannels.userId, userId)))
      if (channels.length) await tx.insert(membershipChannels).values(channels.map((c) => ({ tenantId, userId, channelAccountId: c.id })))

      await tx.update(invitations).set({ acceptedAt: sql`now()`, acceptedBy: userId }).where(eq(invitations.id, invitation.id))
      return { tenantId }
    })
  }

  private async assertChannels(scope: MemberScope, ids: string[]): Promise<void> {
    if (!ids.length) return
    const found = await scope.tx
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.tenantId, scope.tenantId), inArray(channelAccounts.id, ids)))
    if (found.length !== new Set(ids).size) throw new UnknownChannelError()
  }
}

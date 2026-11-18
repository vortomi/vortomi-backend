import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, serialIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { users } from './access.ts'

/**
 * An invitation to our own console (mockup web-22): whoever accepts it becomes a platform admin.
 * Like a company invitation, only the token's SHA-256 is stored. Platform data: only the server
 * role reads it (RLS on, nothing granted to companies or to Supabase's public API).
 */
export const platformInvitations = pgTable(
  'platform_invitations',
  {
    id: uuidIdColumn(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // One open invitation per person.
    uniqueIndex('platform_invitations_open_email_key')
      .on(t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check('platform_invitations_email_check', sql`${t.email} = lower(${t.email}) and ${t.email} like '%_@_%'`),
    check('platform_invitations_name_check', sql`length(trim(${t.name})) between 1 and 80`),
  ],
)

export const PLATFORM_TEAM_ACTIONS = [
  'admin.invited',
  'admin.invitation_renewed',
  'admin.invitation_revoked',
  'admin.joined',
  'admin.code_reset',
  'admin.removed',
  // Staff (mockup web-28): one device signed out, or all of a person's.
  'admin.session_ended',
  'admin.sessions_ended',
  // Mockup web-30: a link for another staff member to choose a new password.
  'admin.password_reset',
] as const
export type PlatformTeamAction = (typeof PLATFORM_TEAM_ACTIONS)[number]

/** Who did what to whom in the console's team, and when. Rows are only ever added. */
export const platformTeamEvents = pgTable(
  'platform_team_events',
  {
    id: serialIdColumn(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action', { enum: PLATFORM_TEAM_ACTIONS }).notNull(),
    // The person the action was about, by email: invitations have no account yet.
    subjectEmail: text('subject_email').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [index('platform_team_events_created_idx').on(t.createdAt), check('platform_team_events_action_check', oneOf(t.action, PLATFORM_TEAM_ACTIONS))],
)

/** What the console does to companies, as the staff page lists it («Actividad en la consola», web-28). */
export const CONSOLE_ACTIONS = [
  'tenant.created',
  'tenant.updated',
  'tenant.draft_discarded',
  'tenant.activated',
  'tenant.suspended',
  'tenant.cancelled',
  'channel.connected',
  'channel.replaced',
  'channel.refreshed',
  'tenant.admin_invited',
  'tenant.owner_invited',
  'tenant.invitation_renewed',
  'tenant.invitation_revoked',
  'business_type.created',
  'business_type.reclassified',
  // Mockup web-30: a password link for someone of a company, and a new owner.
  'tenant.password_reset',
  'tenant.owner_changed',
] as const
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number]

/**
 * Who of our staff changed what in which company, and when: only the action, never what was typed
 * (no tokens, no data). The company is named at the moment (a discarded draft no longer exists),
 * so there is no foreign key to it. Rows are only ever added; only the server role reads them.
 */
export const platformActivity = pgTable(
  'platform_activity',
  {
    id: serialIdColumn(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action', { enum: CONSOLE_ACTIONS }).notNull(),
    // Named company_*, not tenant_*: this is platform data about a company, never the company's own.
    tenantId: uuid('company_id'),
    tenantName: text('company_name'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('platform_activity_created_idx').on(t.createdAt),
    index('platform_activity_actor_idx').on(t.actorUserId, t.createdAt),
    check('platform_activity_action_check', oneOf(t.action, CONSOLE_ACTIONS)),
    check('platform_activity_company_name_check', sql`${t.tenantName} is null or length(${t.tenantName}) <= 200`),
  ],
)


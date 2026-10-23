import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, oneOf, tenantIdColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { MEMBER_ROLES, MEMBERSHIP_STATUSES, PLATFORM_ROLES } from './enums.ts'
import { channelAccounts, tenants } from './tenancy.ts'

/**
 * A person who can sign in. The id IS the Supabase Auth user id (the token's `sub`):
 * Supabase keeps passwords and sessions, this table keeps who they are to us.
 * Platform-level: one person can belong to several companies.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    platformRole: text('platform_role', { enum: PLATFORM_ROLES }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // Stored normalised so the UNIQUE cannot be dodged with capitals.
    check('users_email_check', sql`${t.email} = lower(${t.email}) and ${t.email} like '%_@_%'`),
    check('users_platform_role_check', oneOf(t.platformRole, PLATFORM_ROLES)),
  ],
)

/** A person's place in one company. Composite key: the same person in two companies is two rows. */
export const memberships = pgTable(
  'memberships',
  {
    tenantId: tenantIdColumn().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('invited'),
    // Sees conversations assigned to someone else (always true for admins).
    canSeeOthers: boolean('can_see_others').notNull().default(false),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ name: 'memberships_pkey', columns: [t.tenantId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
    check('memberships_role_check', oneOf(t.role, MEMBER_ROLES)),
    check('memberships_status_check', oneOf(t.status, MEMBERSHIP_STATUSES)),
    check('memberships_admin_sees_all_check', sql`${t.role} <> 'admin' or ${t.canSeeOthers}`),
  ],
)

/** The numbers an agent attends. Both keys composite: only numbers of the member's own company. */
export const membershipChannels = pgTable(
  'membership_channels',
  {
    tenantId: tenantIdColumn(),
    userId: uuid('user_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'membership_channels_pkey', columns: [t.tenantId, t.userId, t.channelAccountId] }),
    foreignKey({
      name: 'membership_channels_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_channels_channel_fk',
      columns: [t.tenantId, t.channelAccountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }),
  ],
)

/**
 * An invitation to join a company (documentations/03). The link carries a random token;
 * only its SHA-256 is stored, so a copy of the database opens nothing. Who the person will
 * be (role, numbers) waits here until they accept with their own account.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuidIdColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    canSeeOthers: boolean('can_see_others').notNull().default(false),
    // Checked against the company's numbers when created and again when accepted.
    channelAccountIds: uuid('channel_account_ids').array().notNull().default(sql`'{}'::uuid[]`),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    // A company admin, or someone of our team inviting the first admin from the console.
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: uuid('accepted_by'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // One open invitation per person and company.
    uniqueIndex('invitations_open_email_key')
      .on(t.tenantId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check('invitations_email_check', sql`${t.email} = lower(${t.email}) and ${t.email} like '%_@_%'`),
    check('invitations_name_check', sql`length(trim(${t.name})) between 1 and 80`),
    check('invitations_role_check', oneOf(t.role, MEMBER_ROLES)),
    check('invitations_admin_sees_all_check', sql`${t.role} <> 'admin' or ${t.canSeeOthers}`),
  ],
)

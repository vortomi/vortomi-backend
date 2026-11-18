import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAtColumn, timestamptz, uuidIdColumn } from './columns.ts'
import { users } from './access.ts'

/**
 * A one-time link to choose a new password (mockup web-30): the company's owner gives it to their
 * staff, the console to anyone, the staff to each other. Like invitations, only the token's SHA-256
 * is stored. Platform data (company_*, not tenant_*): only the server role reads it (RLS on, nothing
 * granted), so neither the companies' code nor Supabase's public API ever see a link.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuidIdColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    // The company it was given from (its team history); null when the staff gave it to the staff.
    tenantId: uuid('company_id'),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    // A newer link for the same person replaces it.
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId), index('password_resets_company_idx').on(t.tenantId, t.createdAt)],
)

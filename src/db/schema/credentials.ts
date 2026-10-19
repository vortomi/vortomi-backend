import { foreignKey, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tenantIdColumn, timestamptz } from './columns.ts'
import { channelAccounts } from './tenancy.ts'

/**
 * Access token each number sends with, encrypted (modules/channels/credential-cipher.ts).
 * Platform-only: RLS on and NO grant to tenant_scoped, so company code cannot even
 * see that the row exists (drizzle/0007_outbound_security.sql).
 */
export const channelCredentials = pgTable(
  'channel_credentials',
  {
    channelAccountId: uuid('channel_account_id').primaryKey(),
    tenantId: tenantIdColumn(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'channel_credentials_channel_fk',
      columns: [t.tenantId, t.channelAccountId],
      foreignColumns: [channelAccounts.tenantId, channelAccounts.id],
    }).onDelete('cascade'),
  ],
)

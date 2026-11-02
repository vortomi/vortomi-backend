import { sql } from 'drizzle-orm'
import { check, foreignKey, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { oneOf, tenantIdColumn, timestamptz } from './columns.ts'
import { CATALOG_SOURCE_KINDS } from './enums.ts'
import { channelAccounts, tenants } from './tenancy.ts'

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

/**
 * A company whose catalog lives in its own system (prices and availability read live), with the
 * key to that system encrypted like the numbers' tokens. Platform-only, like channel_credentials:
 * RLS on and no grant to tenant_scoped (drizzle security migration of this table).
 */
export const catalogSources = pgTable(
  'catalog_sources',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    kind: text('kind', { enum: CATALOG_SOURCE_KINDS }).notNull(),
    baseUrl: text('base_url').notNull(),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('catalog_sources_kind_check', oneOf(t.kind, CATALOG_SOURCE_KINDS)),
    check('catalog_sources_base_url_check', sql`${t.baseUrl} ~ '^https://'`),
  ],
)

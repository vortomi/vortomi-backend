import { jsonb, pgTable, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns.ts'
import { channelAccounts } from './tenancy.ts'

/** An app Meta delivers a number's messages to, as last read from its WhatsApp account. */
export interface SubscribedApp {
  id: string
  name: string
  /** One of Vortomi's apps; any other app is foreign (mockup web-31). */
  ours: boolean
  /** ISO time it was first seen on this number. */
  firstSeenAt: string
}

/**
 * Which apps receive each number's messages (mockup web-31): Meta delivers every webhook to every
 * app subscribed to the WhatsApp account, so a foreign one is a leak of the company's conversations.
 * The server reads it every few minutes. Platform data (company_*, not tenant_*): only the server
 * role reads it (RLS on, nothing granted), and only the console shows it.
 */
export const channelAppChecks = pgTable('channel_app_checks', {
  channelAccountId: uuid('channel_account_id')
    .primaryKey()
    .references(() => channelAccounts.id, { onDelete: 'cascade' }),
  tenantId: uuid('company_id').notNull(),
  // Null until the first successful read.
  apps: jsonb('apps').$type<SubscribedApp[]>(),
  checkedAt: timestamptz('checked_at'),
  // The last attempt Meta did not answer; null after a successful read.
  failedAt: timestamptz('failed_at'),
})

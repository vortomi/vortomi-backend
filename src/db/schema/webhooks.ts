import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { serialIdColumn, timestamptz } from './columns.ts'

/**
 * Inbox of verified Meta webhooks, stored before answering 200. Platform-level:
 * a payload can carry events of several companies, routed one by one afterwards.
 * Meta does not resend a webhook it considers delivered, so a crash between the
 * 200 and the processing would lose the message without this table. Only
 * signature-valid payloads are stored: persisting forged ones would let anyone
 * fill the database.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: serialIdColumn(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    processedAt: timestamptz('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    // Failures, skipped items and events for numbers no company owns.
    lastError: text('last_error'),
  },
  (t) => [
    // Only unprocessed rows are ever scanned by the recovery sweep.
    index('webhook_events_pending_idx').on(t.receivedAt).where(sql`${t.processedAt} is null`),
    check('webhook_events_attempts_check', sql`${t.attempts} >= 0`),
  ],
)

import { sql } from 'drizzle-orm'
import { check, date, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns.ts'
import { users } from './access.ts'
import { tenants } from './tenancy.ts'

/** Why Vortomi exempts a company from paying (mockup web-49): a closed list; «other» needs a note. */
export const EXEMPTION_REASONS = ['demo', 'internal', 'founder', 'agreement', 'other'] as const
export type ExemptionReason = (typeof EXEMPTION_REASONS)[number]

/**
 * A company the console exempts from paying (documentations/18 §8, mockup web-49): while it lasts no
 * charge is made and the company is never suspended. One row per company, the latest exemption: it
 * lasts while ends_on is null or not yet past. The company may read only whether it is exempt and
 * until when (a column grant, migration 0080); the reason and the note are Vortomi's.
 */
export const companyExemptions = pgTable(
  'company_exemptions',
  {
    tenantId: uuid('company_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reason: text('reason', { enum: EXEMPTION_REASONS }).notNull(),
    note: text('note'),
    // The last exempt day (Caracas calendar); null: no end.
    endsOn: date('ends_on', { mode: 'string' }),
    // What the company owed when it was exempted, forgiven (dollar cents).
    forgivenCents: integer('forgiven_cents').notNull().default(0),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamptz('granted_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('company_exemptions_reason_check', sql`${t.reason} in ('demo', 'internal', 'founder', 'agreement', 'other')`),
    check('company_exemptions_note_check', sql`${t.note} is null or char_length(${t.note}) <= 300`),
    check('company_exemptions_other_note_check', sql`${t.reason} <> 'other' or ${t.note} is not null`),
    check('company_exemptions_forgiven_check', sql`${t.forgivenCents} >= 0`),
  ],
)

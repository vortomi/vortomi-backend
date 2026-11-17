import { sql } from 'drizzle-orm'
import { boolean, check, date, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { oneOf, tenantIdColumn, timestamptz } from './columns.ts'
import { AGENT_SCHEDULES, AGENT_TONES, DEFAULT_HUMAN_PAUSE_MINUTES, HUMAN_PAUSE_MINUTES } from './enums.ts'
import { tenants } from './tenancy.ts'

// The sales agent: it answers customers by itself while its company keeps it on. It only ever
// reads that conversation and the company's public data (catalog, rate, hours, business info).

/** One row per company; created on first save. Off until an admin turns it on. */
export const agentSettings = pgTable(
  'agent_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    enabled: boolean('enabled').notNull().default(false),
    // The name it introduces itself with ("Soy Ana, de Repuestos Ávila").
    assistantName: text('assistant_name').notNull().default('Asistente'),
    tone: text('tone', { enum: AGENT_TONES }).notNull().default('friendly'),
    schedule: text('schedule', { enum: AGENT_SCHEDULES }).notNull().default('always'),
    // What the company lets the agent tell anyone: address, payment methods, delivery, policies.
    businessInfo: text('business_info').notNull().default(''),
    // After someone of the company writes in a conversation (panel or the owner's phone), the agent
    // leaves it to them this many minutes from their last message.
    humanPauseMinutes: integer('human_pause_minutes').notNull().default(DEFAULT_HUMAN_PAUSE_MINUTES),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('agent_settings_tone_check', oneOf(t.tone, AGENT_TONES)),
    check('agent_settings_schedule_check', oneOf(t.schedule, AGENT_SCHEDULES)),
    check('agent_settings_assistant_name_check', sql`length(${t.assistantName}) between 1 and 40`),
    check('agent_settings_business_info_check', sql`length(${t.businessInfo}) <= 4000`),
    check('agent_settings_human_pause_minutes_check', sql`${t.humanPauseMinutes} in (${sql.raw(HUMAN_PAUSE_MINUTES.join(', '))})`),
  ],
)

/** What the agent spent, per company and month: the monthly cap and the console read it. */
export const agentUsage = pgTable(
  'agent_usage',
  {
    tenantId: tenantIdColumn().references(() => tenants.id),
    // First day of the month, in UTC.
    month: date('month', { mode: 'string' }).notNull(),
    replies: integer('replies').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'agent_usage_pkey', columns: [t.tenantId, t.month] }),
    check('agent_usage_counts_check', sql`${t.replies} >= 0 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`),
  ],
)

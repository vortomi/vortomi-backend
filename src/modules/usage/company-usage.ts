import { sql } from 'drizzle-orm'
import type { Executor } from '../../db/client.ts'
import { TenantNotFoundError } from '../platform/tenant-admin-service.ts'

/** The console counts days and hours in Venezuela's calendar, like «Uso y salud». */
const PLATFORM_ZONE = 'America/Caracas'

export interface CompanyUsage {
  from: string
  to: string
  tenant: { id: string; name: string; plan: string; status: string; city: string; createdAt: string }
  days: { date: string; fromCustomers: number; automatic: number; staff: number; ownerApp: number }[]
  /** 0 to 23, only hours with messages. */
  hours: { hour: number; fromCustomers: number; answers: number }[]
  /** Each customer message to the next answer of anyone (the agent included); null: none answered. */
  replies: { customerMessages: number; unanswered: number; medianSec: number | null }
  delivery: { outbound: number; delivered: number; failed: number }
  /** People of the team who answered in the range. */
  staffPeople: number
  agent: {
    settings: { enabled: boolean; schedule: string; humanPauseMinutes: number } | null
    /** The months of the range and the one before it, oldest first. */
    months: { month: string; replies: number; inputTokens: number; outputTokens: number }[]
  }
  numbers: { id: string; label: string; displayNumber: string; status: string; statusReason: string | null; coexistence: boolean; tokenExpiresAt: string | null }[]
  /** Right now, whatever the range. */
  operation: {
    conversations: number
    open: number
    newConversations: number
    orders: { status: string; count: number }[]
    people: { role: string; count: number }[]
    approvedTemplates: number
  }
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[]

/**
 * One company's «Uso y salud» for the console (mockup web-27): when its customers write, who
 * answers and how fast, what Meta delivered, its agent, its numbers and its operation. Counts only,
 * from what is stored; no message is ever read. Server role, scoped by the company id in every query.
 */
export class CompanyUsageService {
  async usage(executor: Executor, tenantId: string, from: string, to: string): Promise<CompanyUsage> {
    const starts = sql`(${from}::date::timestamp at time zone ${PLATFORM_ZONE})`
    const ends = sql`((${to}::date + 1)::timestamp at time zone ${PLATFORM_ZONE})`
    const inRange = (column: string) => sql`${sql.raw(column)} >= ${starts} and ${sql.raw(column)} < ${ends}`

    const [tenant] = rowsOf<CompanyUsage['tenant']>(
      await executor.execute(sql`
        select id, name, plan, status, city, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt"
        from tenants where id = ${tenantId}::uuid`),
    )
    if (!tenant) throw new TenantNotFoundError()

    const [days, hours, replies, delivery, staff, settings, months, numbers, operation] = await Promise.all([
      executor.execute(sql`
        select to_char(m.created_at at time zone ${PLATFORM_ZONE}, 'YYYY-MM-DD') as "date",
               count(*) filter (where m.direction = 'in')::int as "fromCustomers",
               count(*) filter (where m.author = 'bot')::int as "automatic",
               count(*) filter (where m.author = 'staff')::int as "staff",
               count(*) filter (where m.author = 'owner_app')::int as "ownerApp"
        from messages m where m.tenant_id = ${tenantId}::uuid and ${inRange('m.created_at')}
        group by 1 order by 1`),
      executor.execute(sql`
        select extract(hour from m.created_at at time zone ${PLATFORM_ZONE})::int as "hour",
               count(*) filter (where m.direction = 'in')::int as "fromCustomers",
               count(*) filter (where m.direction = 'out')::int as "answers"
        from messages m where m.tenant_id = ${tenantId}::uuid and ${inRange('m.created_at')}
        group by 1 order by 1`),
      executor.execute(sql`
        with gaps as (
          select extract(epoch from (
            select min(o.created_at) from messages o
            where o.tenant_id = i.tenant_id and o.conversation_id = i.conversation_id and o.direction = 'out' and o.created_at > i.created_at
          ) - i.created_at) as seconds
          from messages i
          where i.tenant_id = ${tenantId}::uuid and i.direction = 'in' and ${inRange('i.created_at')}
        )
        select count(*)::int as "customerMessages", count(*) filter (where seconds is null)::int as "unanswered",
               round(percentile_cont(0.5) within group (order by seconds))::int as "medianSec"
        from gaps`),
      executor.execute(sql`
        with reported as (
          select e.wa_message_id, bool_or(e.status in ('delivered', 'read')) as delivered, bool_or(e.status = 'failed') as failed
          from message_status_events e
          where e.tenant_id = ${tenantId}::uuid and ${inRange('e.occurred_at')}
          group by 1
        ),
        unsent as (
          select count(*)::int as n from messages m
          where m.tenant_id = ${tenantId}::uuid and m.direction = 'out' and m.send_error is not null and ${inRange('m.created_at')}
        )
        select ((select count(*) from reported) + (select n from unsent))::int as "outbound",
               (select count(*) from reported where delivered)::int as "delivered",
               ((select count(*) from reported where failed and not delivered) + (select n from unsent))::int as "failed"`),
      executor.execute(sql`
        select count(distinct m.author_user_id)::int as "people" from messages m
        where m.tenant_id = ${tenantId}::uuid and m.author = 'staff' and ${inRange('m.created_at')}`),
      executor.execute(sql`
        select enabled, schedule, human_pause_minutes as "humanPauseMinutes" from agent_settings where tenant_id = ${tenantId}::uuid`),
      executor.execute(sql`
        select to_char(a.month, 'YYYY-MM') as "month", a.replies, a.input_tokens::float8 as "inputTokens", a.output_tokens::float8 as "outputTokens"
        from agent_usage a
        where a.tenant_id = ${tenantId}::uuid
          and a.month between (date_trunc('month', ${from}::date) - interval '1 month')::date and date_trunc('month', ${to}::date)::date
        order by 1`),
      executor.execute(sql`
        select id, label, display_number as "displayNumber", status, status_reason as "statusReason", coexistence,
               to_char(token_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "tokenExpiresAt"
        from channel_accounts where tenant_id = ${tenantId}::uuid order by label`),
      executor.execute(sql`
        select
          (select count(*) from conversations where tenant_id = ${tenantId}::uuid)::int as "conversations",
          (select count(*) from conversations where tenant_id = ${tenantId}::uuid and status = 'open')::int as "open",
          (select count(*) from conversations where tenant_id = ${tenantId}::uuid and ${inRange('created_at')})::int as "newConversations",
          (select coalesce(json_agg(json_build_object('status', status, 'count', n) order by status), '[]'::json)
             from (select status, count(*)::int as n from orders where tenant_id = ${tenantId}::uuid group by 1) o) as "orders",
          (select coalesce(json_agg(json_build_object('role', role, 'count', n) order by role), '[]'::json)
             from (select role, count(*)::int as n from memberships where tenant_id = ${tenantId}::uuid and status = 'active' group by 1) p) as "people",
          (select count(*) from message_templates where tenant_id = ${tenantId}::uuid and status = 'approved')::int as "approvedTemplates"`),
    ])
    const [reply] = rowsOf<CompanyUsage['replies']>(replies)
    const [sent] = rowsOf<CompanyUsage['delivery']>(delivery)
    const [team] = rowsOf<{ people: number }>(staff)
    const [config] = rowsOf<NonNullable<CompanyUsage['agent']['settings']>>(settings)
    const [now] = rowsOf<CompanyUsage['operation']>(operation)
    return {
      from,
      to,
      tenant,
      days: rowsOf(days),
      hours: rowsOf(hours),
      replies: reply ?? { customerMessages: 0, unanswered: 0, medianSec: null },
      delivery: sent ?? { outbound: 0, delivered: 0, failed: 0 },
      staffPeople: team?.people ?? 0,
      agent: { settings: config ?? null, months: rowsOf(months) },
      numbers: rowsOf(numbers),
      operation: now ?? { conversations: 0, open: 0, newConversations: 0, orders: [], people: [], approvedTemplates: 0 },
    }
  }
}

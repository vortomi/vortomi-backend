import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Executor } from '../../db/client.ts'

/** The console counts days in Venezuela's calendar, like the companies' reports. */
const PLATFORM_ZONE = 'America/Caracas'
/** The longest range the console asks for (a month and its comparison fit). */
const MAX_DAYS = 62

const day = z.iso.date()
export const overviewQuery = z
  .object({ from: day, to: day })
  .refine(({ from, to }) => from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 < MAX_DAYS, 'from..to, at most 62 days')

/** One company's messages of one day, by who wrote them. */
export interface OverviewDay {
  date: string
  tenantId: string
  fromCustomers: number
  /** The sales agent and the fixed automatic lines (away message, receipt acknowledgement). */
  automatic: number
  staff: number
  /** Written by the owner from the WhatsApp Business app (coexistence). */
  ownerApp: number
}

/** What happened to a company's outbound messages in the range, as Meta reported it. */
export interface OverviewDelivery {
  tenantId: string
  /** Outbound messages Meta reported on, plus the ones that never reached it. */
  outbound: number
  delivered: number
  failed: number
}

export interface OverviewAgent {
  tenantId: string
  replies: number
  inputTokens: number
  outputTokens: number
}

/** Right now, whatever the range: what our team must keep an eye on. */
export interface PlatformHealth {
  webhooks: { pending: number; retrying: number; last24h: number; lastAt: string | null }
  numbers: { connected: number; disconnected: number; restricted: number }
  failedLast24h: number
  agentCompanies: number
  companies: { active: number; numbers: number; people: number }
}

export interface PlatformOverview {
  from: string
  to: string
  days: OverviewDay[]
  delivery: OverviewDelivery[]
  agent: OverviewAgent[]
  health: PlatformHealth
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[]

/**
 * «Uso y salud» of the platform console (mockup web-26): counts across every company for a range
 * of days, and the platform's health now. Derived from what is already stored (messages, Meta's
 * delivery statuses, the agent's monthly usage, webhooks, numbers): nothing counted apart, and
 * never a message's content. Server role only: it spans companies.
 */
export class PlatformOverviewService {
  async overview(executor: Executor, from: string, to: string): Promise<PlatformOverview> {
    // Day bounds in Venezuela's time, as text: postgres-js does not bind a bare Date inside sql``.
    const starts = sql`(${from}::date::timestamp at time zone ${PLATFORM_ZONE})`
    const ends = sql`((${to}::date + 1)::timestamp at time zone ${PLATFORM_ZONE})`

    const [days, delivery, agent, health] = await Promise.all([
      executor.execute(sql`
        select to_char(m.created_at at time zone ${PLATFORM_ZONE}, 'YYYY-MM-DD') as "date", m.tenant_id as "tenantId",
               count(*) filter (where m.direction = 'in')::int as "fromCustomers",
               count(*) filter (where m.author = 'bot')::int as "automatic",
               count(*) filter (where m.author = 'staff')::int as "staff",
               count(*) filter (where m.author = 'owner_app')::int as "ownerApp"
        from messages m
        where m.created_at >= ${starts} and m.created_at < ${ends}
        group by 1, 2
        order by 1, 2`),
      executor.execute(sql`
        with reported as (
          select e.tenant_id, e.wa_message_id,
                 bool_or(e.status in ('delivered', 'read')) as delivered,
                 bool_or(e.status = 'failed') as failed
          from message_status_events e
          where e.occurred_at >= ${starts} and e.occurred_at < ${ends}
          group by 1, 2
        ),
        unsent as (
          select m.tenant_id, count(*)::int as n from messages m
          where m.direction = 'out' and m.send_error is not null and m.created_at >= ${starts} and m.created_at < ${ends}
          group by 1
        ),
        totals as (
          select tenant_id, count(*)::int as outbound, count(*) filter (where delivered)::int as delivered,
                 count(*) filter (where failed and not delivered)::int as failed
          from reported group by 1
        )
        select coalesce(t.tenant_id, u.tenant_id) as "tenantId",
               (coalesce(t.outbound, 0) + coalesce(u.n, 0))::int as "outbound",
               coalesce(t.delivered, 0)::int as "delivered",
               (coalesce(t.failed, 0) + coalesce(u.n, 0))::int as "failed"
        from totals t full join unsent u on u.tenant_id = t.tenant_id`),
      executor.execute(sql`
        select a.tenant_id as "tenantId", sum(a.replies)::int as "replies",
               sum(a.input_tokens)::bigint::float8 as "inputTokens", sum(a.output_tokens)::bigint::float8 as "outputTokens"
        from agent_usage a
        where a.month between date_trunc('month', ${from}::date)::date and date_trunc('month', ${to}::date)::date
        group by 1`),
      this.health(executor),
    ])
    return {
      from,
      to,
      days: rowsOf<OverviewDay>(days),
      delivery: rowsOf<OverviewDelivery>(delivery),
      agent: rowsOf<OverviewAgent>(agent),
      health,
    }
  }

  private async health(executor: Executor): Promise<PlatformHealth> {
    const [row] = rowsOf<Record<string, number | string | null>>(
      await executor.execute(sql`
        select
          (select count(*) from webhook_events where processed_at is null)::int as "pending",
          (select count(*) from webhook_events where processed_at is null and attempts > 0)::int as "retrying",
          (select count(*) from webhook_events where received_at > now() - interval '24 hours')::int as "last24h",
          (select to_char(max(received_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from webhook_events) as "lastAt",
          (select count(*) from channel_accounts where status = 'connected')::int as "connected",
          (select count(*) from channel_accounts where status = 'disconnected')::int as "disconnected",
          (select count(*) from channel_accounts where status = 'restricted')::int as "restricted",
          ((select count(distinct (tenant_id, wa_message_id)) from message_status_events
             where status = 'failed' and occurred_at > now() - interval '24 hours')
           + (select count(*) from messages where direction = 'out' and send_error is not null and created_at > now() - interval '24 hours'))::int as "failedLast24h",
          (select count(*) from agent_settings where enabled)::int as "agentCompanies",
          (select count(*) from tenants where status = 'active')::int as "activeCompanies",
          (select count(*) from channel_accounts c join tenants t on t.id = c.tenant_id where t.status = 'active')::int as "activeNumbers",
          (select count(*) from memberships ms join tenants t on t.id = ms.tenant_id where t.status = 'active' and ms.status = 'active')::int as "people"`),
    )
    const n = (key: string) => Number(row?.[key] ?? 0)
    return {
      webhooks: { pending: n('pending'), retrying: n('retrying'), last24h: n('last24h'), lastAt: (row?.['lastAt'] as string | null) ?? null },
      numbers: { connected: n('connected'), disconnected: n('disconnected'), restricted: n('restricted') },
      failedLast24h: n('failedLast24h'),
      agentCompanies: n('agentCompanies'),
      companies: { active: n('activeCompanies'), numbers: n('activeNumbers'), people: n('people') },
    }
  }
}

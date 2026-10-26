import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { MemberScope } from '../access/member-scope.ts'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/** At most a bit over a year per request: the panel asks for its periods and their comparison. */
export const reportRange = z
  .object({ from: day, to: day })
  .refine(({ from, to }) => from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 <= 400, 'from <= to, 400 days at most')

/** A first reply in this long or less counts as on time (documentations/02, Reportes). */
export const ON_TIME_SECONDS = 15 * 60

/** One person's day; userId null = nobody answered and nobody had it assigned. */
export interface ReportDay {
  date: string
  userId: string | null
  conversations: number
  onTime: number
  firstResponseMedianSec: number | null
  wonCount: number
  wonCents: number
}

// FULL JOIN needs a plain equality: "nobody" gets a stand-in id while the two halves are joined.
const NOBODY = '00000000-0000-0000-0000-000000000000'

/**
 * Attention and sales per day and person, derived from what is already stored (messages and the
 * pipeline's history), in the company's own time zone. Counts only: nothing of what was written.
 *
 * - A conversation counts once per day the customer wrote, from their first message that day.
 * - Its first reply is the first message a person of the team sent after it (templates by a
 *   person count; automatic messages do not). The person is who replied, else who had it assigned.
 * - Won: moves into the company's last pipeline stage that day, by whoever made them.
 */
export class ReportService {
  async days(scope: MemberScope, from: string, to: string): Promise<ReportDay[]> {
    const tenant = scope.tenantId
    const result = await scope.tx.execute(sql`
      with bounds as (
        select t.timezone,
               (${from}::date::timestamp at time zone t.timezone) as starts,
               ((${to}::date + 1)::timestamp at time zone t.timezone) as ends
        from tenants t where t.id = ${tenant}::uuid
      ),
      inbound as (
        select m.conversation_id, (m.created_at at time zone b.timezone)::date as day, min(m.created_at) as first_in
        from messages m, bounds b
        where m.tenant_id = ${tenant}::uuid and m.direction = 'in' and m.created_at >= b.starts and m.created_at < b.ends
        group by 1, 2
      ),
      attention as (
        select i.day, coalesce(r.author_user_id, c.assigned_user_id, ${NOBODY}::uuid) as user_id, i.first_in, r.created_at as reply_at
        from inbound i
        join conversations c on c.tenant_id = ${tenant}::uuid and c.id = i.conversation_id
        left join lateral (
          select o.created_at, o.author_user_id from messages o
          where o.tenant_id = ${tenant}::uuid and o.conversation_id = i.conversation_id
            and o.direction = 'out' and o.author = 'staff' and o.created_at >= i.first_in
          order by o.created_at limit 1
        ) r on true
      ),
      attention_days as (
        select day, user_id, count(*)::int as conversations,
               count(*) filter (where reply_at - first_in <= make_interval(secs => ${ON_TIME_SECONDS}))::int as on_time,
               percentile_cont(0.5) within group (order by extract(epoch from reply_at - first_in))
                 filter (where reply_at is not null) as median
        from attention group by 1, 2
      ),
      last_stage as (
        select id from pipeline_stages where tenant_id = ${tenant}::uuid order by position desc, name desc limit 1
      ),
      won as (
        select (e.created_at at time zone b.timezone)::date as day, coalesce(e.changed_by, ${NOBODY}::uuid) as user_id,
               count(*)::int as won_count, coalesce(sum(e.quote_cents), 0)::float8 as won_cents
        from contact_stage_events e, bounds b, last_stage s
        where e.tenant_id = ${tenant}::uuid and e.stage_id = s.id and e.created_at >= b.starts and e.created_at < b.ends
        group by 1, 2
      )
      select to_char(coalesce(a.day, w.day), 'YYYY-MM-DD') as "date",
             nullif(coalesce(a.user_id, w.user_id), ${NOBODY}::uuid) as "userId",
             coalesce(a.conversations, 0) as "conversations",
             coalesce(a.on_time, 0) as "onTime",
             round(a.median)::int as "firstResponseMedianSec",
             coalesce(w.won_count, 0) as "wonCount",
             coalesce(w.won_cents, 0) as "wonCents"
      from attention_days a
      full join won w on w.day = a.day and w.user_id = a.user_id
      order by 1, 2`)
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as ReportDay[]
    // Drivers differ on numeric types; the panel gets plain numbers.
    return rows.map((row) => ({ ...row, wonCents: Number(row.wonCents) }))
  }
}

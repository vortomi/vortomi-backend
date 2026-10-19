import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Executor } from '../../db/client.ts'

export const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

/** One number's month, in the shape the panel's spend estimate takes (UsageMonth). */
export interface UsageRow {
  tenantId: string
  channelAccountId: string
  month: string
  totalMessages: number
  serviceMessages: number
  utilityMessages: number
  marketingMessages: number
  authenticationMessages: number
  /** Inside a 72 h free entry point (ads that click to WhatsApp): never charged. */
  freeEntryMessages: number
}

/**
 * Monthly usage per number, derived from what is already stored: the messages, and
 * the pricing Meta attaches to each delivery status. No counters to drift. The month
 * is the company's own (tenants.timezone). Pricing categories follow Meta's status
 * webhook; 'referral_conversion' is the free entry point.
 *
 * Takes any executor: a company scope (RLS limits it to that company) or the server
 * role for the platform console, which only ever gets counts, never content.
 */
export class UsageService {
  async monthly(executor: Executor, month: string, tenantId?: string): Promise<UsageRow[]> {
    const onlyTenant = tenantId ? sql`and t.id = ${tenantId}::uuid` : sql``
    const result = await executor.execute(sql`
      with bounds as (
        select t.id as tenant_id,
               (${`${month}-01`}::timestamp at time zone t.timezone) as starts,
               ((${`${month}-01`}::timestamp + interval '1 month') at time zone t.timezone) as ends
        from tenants t where true ${onlyTenant}
      ),
      traffic as (
        select c.tenant_id, c.channel_account_id, count(*)::int as total
        from messages m
        join conversations v on v.tenant_id = m.tenant_id and v.id = m.conversation_id
        join contacts c on c.tenant_id = v.tenant_id and c.id = v.contact_id
        join bounds b on b.tenant_id = m.tenant_id
        where m.created_at >= b.starts and m.created_at < b.ends
        group by 1, 2
      ),
      priced as (
        select c.tenant_id, c.channel_account_id, e.pricing_category as category, count(distinct e.wa_message_id)::int as sent
        from message_status_events e
        join messages m on m.tenant_id = e.tenant_id and m.wa_message_id = e.wa_message_id
        join conversations v on v.tenant_id = m.tenant_id and v.id = m.conversation_id
        join contacts c on c.tenant_id = v.tenant_id and c.id = v.contact_id
        join bounds b on b.tenant_id = e.tenant_id
        where e.status = 'sent' and e.occurred_at >= b.starts and e.occurred_at < b.ends
        group by 1, 2, 3
      )
      select t.tenant_id as "tenantId", t.channel_account_id as "channelAccountId", t.total as "totalMessages",
             coalesce(sum(p.sent) filter (where p.category = 'service'), 0)::int as "serviceMessages",
             coalesce(sum(p.sent) filter (where p.category = 'utility'), 0)::int as "utilityMessages",
             coalesce(sum(p.sent) filter (where p.category = 'marketing'), 0)::int as "marketingMessages",
             coalesce(sum(p.sent) filter (where p.category = 'authentication'), 0)::int as "authenticationMessages",
             coalesce(sum(p.sent) filter (where p.category = 'referral_conversion'), 0)::int as "freeEntryMessages"
      from traffic t
      left join priced p on p.tenant_id = t.tenant_id and p.channel_account_id = t.channel_account_id
      group by t.tenant_id, t.channel_account_id, t.total
      order by t.tenant_id, t.channel_account_id`)
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Omit<UsageRow, 'month'>[]
    return rows.map((row) => ({ ...row, month }))
  }
}

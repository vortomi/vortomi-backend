import { type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { monthOf } from '../agent/sales-agent.ts'

/** Days and months are counted in Venezuela's time, like the companies' own reports. */
const ZONE = 'America/Caracas'
const LIST_DAYS = 14
const DETAIL_DAYS = 30

/** What a company needs before it sells on its own (the console's «Puesta en marcha»). */
export const SETUP_STEPS = ['number', 'business_info', 'products', 'payment_methods', 'template', 'agent'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export interface SetupItem {
  step: SetupStep
  done: boolean
  /** How many there are, for the steps that count something (products, methods, templates). */
  count: number | null
}

/** One company in the console's list (mockup web-25, step 1). */
export interface TenantListInsight {
  tenantId: string
  /** Messages of each of the last 14 days, oldest first; the last one is today. */
  daily: number[]
  lastActivityAt: string | null
  agentEnabled: boolean
  agentReplies: number
  setupDone: number
  pendingInvitations: number
}

export interface TenantListInsights {
  items: TenantListInsight[]
  /** The whole platform this month so far, and the same days of last month. */
  monthMessages: number
  previousMonthMessages: number
  agentRepliesMonth: number
  agentCap: number
  setupTotal: number
}

/** One company's page (mockup web-25, step 2). */
export interface TenantDetailInsights {
  daily: { day: string; fromCustomers: number; fromCompany: number }[]
  messages30d: number
  previous30d: number
  openConversations: number
  unassignedOpen: number
  contacts: number
  contactsThisMonth: number
  ordersThisMonth: number
  ordersAwaitingPayment: number
  agent: { enabled: boolean; replies: number; cap: number }
  lastActivity: { at: string; fromCustomer: boolean } | null
  channels: { channelId: string; connectedAt: string; lastInboundAt: string | null; messages30d: number; coexistence: boolean }[]
  setup: SetupItem[]
  owner: { name: string; email: string } | null
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[]
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString())

/**
 * The figures the platform console shows about each company: activity, agent, setup and who to
 * call. Counts and dates only, derived from what is already stored: never a message's content.
 * Server role only (it spans companies), behind the console's guard (super admin + second factor).
 */
export class TenantInsightService {
  constructor(
    private readonly db: Database,
    private readonly agentCap: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<TenantListInsights> {
    const t = this.clock()
    const [daily, last, agent, setup, invitations, month] = await Promise.all([
      this.db.execute(sql`
        select m.tenant_id as "tenantId", ((m.created_at at time zone ${ZONE})::date - ${t.daysAgo(LIST_DAYS - 1)})::int as "index", count(*)::int as "n"
        from messages m where m.created_at >= ${t.startOf(LIST_DAYS - 1)}
        group by 1, 2`),
      this.db.execute(sql`select m.tenant_id as "tenantId", max(m.created_at) as "at" from messages m group by 1`),
      this.db.execute(sql`
        select s.tenant_id as "tenantId", s.enabled as "enabled", coalesce(u.replies, 0)::int as "replies"
        from agent_settings s left join agent_usage u on u.tenant_id = s.tenant_id and u.month = ${monthOf(t.at)}`),
      this.db.execute(sql`select t.id as "tenantId", ${setupColumns(sql`t.id`)} from tenants t`),
      this.db.execute(sql`
        select i.tenant_id as "tenantId", count(*)::int as "n" from invitations i
        where i.accepted_at is null and i.revoked_at is null and i.expires_at > ${t.sql}
        group by 1`),
      this.db.execute(sql`
        select count(*) filter (where m.created_at >= ${t.monthStart})::int as "month",
               count(*) filter (where m.created_at < ${t.previousMonthStart} + (${t.sql} - ${t.monthStart}))::int as "previous"
        from messages m where m.created_at >= ${t.previousMonthStart}`),
    ])

    const days = new Map<string, number[]>()
    for (const row of rowsOf<{ tenantId: string; index: number; n: number }>(daily)) {
      const list = days.get(row.tenantId) ?? Array<number>(LIST_DAYS).fill(0)
      if (row.index >= 0 && row.index < LIST_DAYS) list[row.index] = row.n
      days.set(row.tenantId, list)
    }
    const lastAt = new Map(rowsOf<{ tenantId: string; at: unknown }>(last).map((r) => [r.tenantId, iso(r.at)]))
    const agents = new Map(rowsOf<{ tenantId: string; enabled: boolean; replies: number }>(agent).map((r) => [r.tenantId, r]))
    const pending = new Map(rowsOf<{ tenantId: string; n: number }>(invitations).map((r) => [r.tenantId, r.n]))
    const totals = rowsOf<{ month: number; previous: number }>(month)[0] ?? { month: 0, previous: 0 }

    const items = rowsOf<SetupRow & { tenantId: string }>(setup).map((row) => ({
      tenantId: row.tenantId,
      daily: days.get(row.tenantId) ?? Array<number>(LIST_DAYS).fill(0),
      lastActivityAt: lastAt.get(row.tenantId) ?? null,
      agentEnabled: agents.get(row.tenantId)?.enabled ?? false,
      agentReplies: agents.get(row.tenantId)?.replies ?? 0,
      setupDone: setupOf(row).filter((s) => s.done).length,
      pendingInvitations: pending.get(row.tenantId) ?? 0,
    }))
    return {
      items,
      monthMessages: totals.month,
      previousMonthMessages: totals.previous,
      agentRepliesMonth: items.reduce((sum, i) => sum + i.agentReplies, 0),
      agentCap: this.agentCap,
      setupTotal: SETUP_STEPS.length,
    }
  }

  /** Null when there is no such company. */
  async detail(tenantId: string): Promise<TenantDetailInsights | null> {
    const t = this.clock()
    const [exists] = rowsOf<{ id: string }>(await this.db.execute(sql`select id from tenants where id = ${tenantId}`))
    if (!exists) return null
    const [daily, period, inbox, people, orders, agent, last, channels, setup, owner] = await Promise.all([
      this.db.execute(sql`
        select to_char(d.day, 'YYYY-MM-DD') as "day",
               count(m.id) filter (where m.direction = 'in')::int as "fromCustomers",
               count(m.id) filter (where m.direction = 'out')::int as "fromCompany"
        from generate_series(${t.daysAgo(DETAIL_DAYS - 1)}, ${t.today}, interval '1 day') as d(day)
        left join messages m on m.tenant_id = ${tenantId} and (m.created_at at time zone ${ZONE})::date = d.day::date
          and m.created_at >= ${t.startOf(DETAIL_DAYS - 1)}
        group by d.day order by d.day`),
      this.db.execute(sql`
        select count(*) filter (where m.created_at >= ${t.startOf(DETAIL_DAYS - 1)})::int as "current",
               count(*) filter (where m.created_at < ${t.startOf(DETAIL_DAYS - 1)})::int as "previous"
        from messages m where m.tenant_id = ${tenantId} and m.created_at >= ${t.startOf(2 * DETAIL_DAYS - 1)}`),
      this.db.execute(sql`
        select count(*)::int as "open",
               count(*) filter (where not exists (select 1 from conversation_assignees a where a.tenant_id = c.tenant_id and a.conversation_id = c.id))::int as "unassigned"
        from conversations c where c.tenant_id = ${tenantId} and c.status = 'open'`),
      this.db.execute(sql`
        select count(*)::int as "total", count(*) filter (where k.created_at >= ${t.monthStart})::int as "thisMonth"
        from contacts k where k.tenant_id = ${tenantId}`),
      this.db.execute(sql`
        select count(*) filter (where o.created_at >= ${t.monthStart})::int as "thisMonth",
               count(*) filter (where o.status = 'awaiting_payment')::int as "awaiting"
        from orders o where o.tenant_id = ${tenantId}`),
      this.db.execute(sql`
        select coalesce((select s.enabled from agent_settings s where s.tenant_id = ${tenantId}), false) as "enabled",
               coalesce((select u.replies from agent_usage u where u.tenant_id = ${tenantId} and u.month = ${monthOf(t.at)}), 0)::int as "replies"`),
      this.db.execute(sql`
        select m.created_at as "at", m.direction = 'in' as "fromCustomer" from messages m
        where m.tenant_id = ${tenantId} order by m.created_at desc, m.id desc limit 1`),
      this.db.execute(sql`
        select ch.id as "channelId", ch.created_at as "connectedAt", ch.coexistence as "coexistence",
               (select max(k.last_inbound_at) from contacts k where k.tenant_id = ch.tenant_id and k.channel_account_id = ch.id) as "lastInboundAt",
               (select count(*) from messages m join conversations c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
                  join contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
                where m.tenant_id = ch.tenant_id and k.channel_account_id = ch.id and m.created_at >= ${t.startOf(DETAIL_DAYS - 1)})::int as "messages30d"
        from channel_accounts ch where ch.tenant_id = ${tenantId} order by ch.label`),
      this.db.execute(sql`select ${setupColumns(sql`${tenantId}::uuid`)}`),
      this.db.execute(sql`
        select u.name as "name", u.email as "email" from memberships ms join users u on u.id = ms.user_id
        where ms.tenant_id = ${tenantId} and ms.role = 'admin' and ms.status = 'active'
        order by ms.is_owner desc, ms.created_at, u.name limit 1`),
    ])

    const counts = rowsOf<{ current: number; previous: number }>(period)[0]!
    const box = rowsOf<{ open: number; unassigned: number }>(inbox)[0]!
    const contacts = rowsOf<{ total: number; thisMonth: number }>(people)[0]!
    const sales = rowsOf<{ thisMonth: number; awaiting: number }>(orders)[0]!
    const assistant = rowsOf<{ enabled: boolean; replies: number }>(agent)[0]!
    const latest = rowsOf<{ at: unknown; fromCustomer: boolean }>(last)[0]
    return {
      daily: rowsOf(daily),
      messages30d: counts.current,
      previous30d: counts.previous,
      openConversations: box.open,
      unassignedOpen: box.unassigned,
      contacts: contacts.total,
      contactsThisMonth: contacts.thisMonth,
      ordersThisMonth: sales.thisMonth,
      ordersAwaitingPayment: sales.awaiting,
      agent: { enabled: assistant.enabled, replies: assistant.replies, cap: this.agentCap },
      lastActivity: latest ? { at: iso(latest.at)!, fromCustomer: latest.fromCustomer } : null,
      channels: rowsOf<{ channelId: string; connectedAt: unknown; lastInboundAt: unknown; messages30d: number; coexistence: boolean }>(channels).map((c) => ({
        ...c,
        connectedAt: iso(c.connectedAt)!,
        lastInboundAt: iso(c.lastInboundAt),
      })),
      setup: setupOf(rowsOf<SetupRow>(setup)[0]!),
      owner: rowsOf<{ name: string; email: string }>(owner)[0] ?? null,
    }
  }

  /** «Now» and the day bounds derived from it, in Venezuela's time. ISO text: postgres-js binds no bare Date. */
  private clock() {
    const at = this.now()
    const now = sql`${at.toISOString()}::timestamptz`
    const today = sql`(${now} at time zone ${ZONE})::date`
    const local = sql`(${now} at time zone ${ZONE})`
    return {
      at,
      sql: now,
      today,
      daysAgo: (n: number): SQL => sql`(${today} - ${n}::int)`,
      /** The instant the day `n` days ago began. */
      startOf: (n: number): SQL => sql`((${today} - ${n}::int)::timestamp at time zone ${ZONE})`,
      monthStart: sql`(date_trunc('month', ${local}) at time zone ${ZONE})`,
      previousMonthStart: sql`((date_trunc('month', ${local}) - interval '1 month') at time zone ${ZONE})`,
    }
  }
}

interface SetupRow {
  connected: boolean
  businessInfo: boolean
  products: number
  paymentMethods: number
  templates: number
  agent: boolean
}

/** The setup checks of one company, as columns of a select (`tenant` is its id expression). */
function setupColumns(tenant: SQL): SQL {
  return sql`
    exists (select 1 from channel_accounts ch where ch.tenant_id = ${tenant} and ch.status = 'connected') as "connected",
    coalesce((select length(trim(s.business_info)) > 0 from agent_settings s where s.tenant_id = ${tenant}), false) as "businessInfo",
    (select count(*) from products p where p.tenant_id = ${tenant} and p.active)::int as "products",
    (select count(*) from payment_methods pm where pm.tenant_id = ${tenant} and pm.is_active)::int as "paymentMethods",
    (select count(*) from message_templates mt where mt.tenant_id = ${tenant} and mt.status = 'approved')::int as "templates",
    coalesce((select s.enabled from agent_settings s where s.tenant_id = ${tenant}), false) as "agent"`
}

function setupOf(row: SetupRow): SetupItem[] {
  return [
    { step: 'number', done: row.connected, count: null },
    { step: 'business_info', done: row.businessInfo, count: null },
    { step: 'products', done: row.products > 0, count: row.products },
    { step: 'payment_methods', done: row.paymentMethods > 0, count: row.paymentMethods },
    { step: 'template', done: row.templates > 0, count: row.templates },
    { step: 'agent', done: row.agent, count: null },
  ]
}

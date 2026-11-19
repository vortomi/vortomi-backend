import { and, count, eq, gt, gte, isNotNull, isNull, like, max, min, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { agentSettings, agentUsage, bcvStatus, channelAccounts, channelAppChecks, conversations, tenantSettings, tenants, webhookEvents } from '../../db/schema/index.ts'
import { dayIn } from '../../shared/time-zone.ts'
import type { UsageService } from '../usage/usage-service.ts'
import { ALERT_LIMITS, type AlertFacts, type PlatformAlert, platformAlerts } from './platform-alert-rules.ts'

const DAY_MS = 86_400_000
/** Usage months are counted in Venezuela's calendar, like the console's other pages. */
const PLATFORM_ZONE = 'America/Caracas'
/** How far back the webhook problems are looked for (processed webhooks are kept 30 days). */
const WEBHOOK_WINDOW_MS = 2 * DAY_MS
const FAILED_WINDOW_MS = 7 * DAY_MS
/** The number's usual traffic is measured over this many days before the silence. */
const BASELINE_DAYS = 30
/** The apps of a number read longer ago than this (the watch reads every 15 min) are not vouched for. */
const APPS_FRESH_MS = 60 * 60_000

export interface PlatformAlertReport {
  checkedAt: string
  /** What was looked at, so «todo en orden» says it. */
  checked: { companies: number; numbers: number; connected: number; appsUnread: number }
  alerts: PlatformAlert[]
}

/**
 * The console's alerts (mockup web-25), computed from what Vortomi already stores: numbers and
 * their access, webhooks Meta sent, the agent's monthly use, the companies' own catalogs, the BCV
 * and Meta's free replies. Server role: it spans every company and reads no conversation's text.
 */
export class PlatformAlertService {
  constructor(
    private readonly db: Database,
    private readonly usage: Pick<UsageService, 'monthly'>,
    private readonly options: { agentCap: number; webhookMaxAttempts: number; now?: () => Date },
  ) {}

  async report(): Promise<PlatformAlertReport> {
    const now = this.options.now?.() ?? new Date()
    const [companies, channels, webhooksFailed, unroutable, bcv, agent, catalog, usage, inbound] = await Promise.all([
      this.db.select({ id: tenants.id, name: tenants.name, status: tenants.status, createdAt: tenants.createdAt }).from(tenants),
      this.channels(),
      this.webhooksFailed(now),
      this.unroutable(now),
      this.bcv(),
      this.agentUsage(now),
      this.catalogHandoffs(now),
      this.usage.monthly(this.db, dayIn(now, PLATFORM_ZONE).slice(0, 7)),
      this.inbound(now),
    ])
    const facts: AlertFacts = {
      now,
      tenants: companies,
      channels,
      webhooksFailed,
      unroutable,
      bcv,
      agentUsage: agent,
      agentCap: this.options.agentCap,
      catalogHandoffs: catalog,
      serviceReplies: usage.map((u) => ({ tenantId: u.tenantId, channelId: u.channelAccountId, count: u.serviceMessages })),
      inbound,
    }
    const live = new Set(companies.filter((c) => c.status !== 'cancelled').map((c) => c.id))
    const own = channels.filter((c) => live.has(c.tenantId))
    return {
      checkedAt: now.toISOString(),
      checked: { companies: live.size, numbers: own.length, connected: own.filter((c) => c.status === 'connected').length, appsUnread: own.filter((c) => !c.appsCheckedAt || now.getTime() - c.appsCheckedAt.getTime() > APPS_FRESH_MS).length },
      alerts: platformAlerts(facts),
    }
  }

  /** Each number with the apps not ours that Meta delivers its messages to (mockup web-31). */
  private async channels(): Promise<(AlertFacts['channels'][number] & { appsCheckedAt: Date | null })[]> {
    const rows = await this.db
      .select({ id: channelAccounts.id, tenantId: channelAccounts.tenantId, label: channelAccounts.label, status: channelAccounts.status, statusReason: channelAccounts.statusReason, statusChangedAt: channelAccounts.statusChangedAt, tokenExpiresAt: channelAccounts.tokenExpiresAt, wabaId: channelAccounts.wabaId, apps: channelAppChecks.apps, appsCheckedAt: channelAppChecks.checkedAt })
      .from(channelAccounts)
      .leftJoin(channelAppChecks, eq(channelAppChecks.channelAccountId, channelAccounts.id))
    return rows.map(({ apps, ...channel }) => ({ ...channel, foreignApps: (apps ?? []).filter((app) => !app.ours).map(({ id, name, firstSeenAt }) => ({ id, name, firstSeenAt })) }))
  }

  /** Webhooks every attempt failed on: customer messages in them may be missing from the inbox. */
  private async webhooksFailed(now: Date): Promise<AlertFacts['webhooksFailed']> {
    const since = new Date(now.getTime() - FAILED_WINDOW_MS)
    const [row] = await this.db
      .select({ count: count(), firstAt: min(webhookEvents.receivedAt), lastAt: max(webhookEvents.receivedAt) })
      .from(webhookEvents)
      .where(and(isNull(webhookEvents.processedAt), gte(webhookEvents.attempts, this.options.webhookMaxAttempts), gt(webhookEvents.receivedAt, since)))
    if (!row?.count || !row.firstAt) return null
    const [last] = await this.db
      .select({ error: webhookEvents.lastError })
      .from(webhookEvents)
      .where(and(isNull(webhookEvents.processedAt), gte(webhookEvents.attempts, this.options.webhookMaxAttempts), gt(webhookEvents.receivedAt, since)))
      .orderBy(sql`${webhookEvents.receivedAt} desc`)
      .limit(1)
    // Only its first line and length-bound: it is shown to our team, never to a company.
    return { count: row.count, firstAt: row.firstAt, lastError: last?.error?.split('\n')[0]?.slice(0, 160) ?? null }
  }

  /** Numbers or accounts Meta wrote about that no company owns (the processor's «unroutable» note). */
  private async unroutable(now: Date): Promise<AlertFacts['unroutable']> {
    const rows = await this.db
      .select({ note: webhookEvents.lastError, at: webhookEvents.receivedAt })
      .from(webhookEvents)
      .where(and(isNotNull(webhookEvents.processedAt), like(webhookEvents.lastError, '%unroutable: %'), gt(webhookEvents.receivedAt, new Date(now.getTime() - WEBHOOK_WINDOW_MS))))
      .limit(500)
    const byKey = new Map<string, { count: number; lastAt: Date }>()
    for (const row of rows) {
      const keys = row.note?.match(/unroutable: ([^;]+)/)?.[1]?.split(', ') ?? []
      for (const key of keys.map((k) => k.trim()).filter(Boolean)) {
        const seen = byKey.get(key)
        byKey.set(key, { count: (seen?.count ?? 0) + 1, lastAt: seen && seen.lastAt > row.at ? seen.lastAt : row.at })
      }
    }
    return [...byKey].map(([key, value]) => ({ key, ...value }))
  }

  /** The BCV's last read failed, and some company prices with it. */
  private async bcv(): Promise<AlertFacts['bcv']> {
    const [status] = await this.db.select().from(bcvStatus)
    if (!status?.error) return null
    const [users] = await this.db.select({ count: count() }).from(tenantSettings).where(eq(tenantSettings.rateSource, 'bcv'))
    return { error: status.error, checkedAt: status.checkedAt, rate: status.rate, effectiveDate: status.effectiveDate, companies: users?.count ?? 0 }
  }

  /** This month's agent replies of the companies that keep it on (agent_usage months are UTC). */
  private agentUsage(now: Date): Promise<AlertFacts['agentUsage']> {
    const month = `${now.toISOString().slice(0, 7)}-01`
    return this.db
      .select({ tenantId: agentUsage.tenantId, replies: agentUsage.replies })
      .from(agentUsage)
      .innerJoin(agentSettings, and(eq(agentSettings.tenantId, agentUsage.tenantId), eq(agentSettings.enabled, true)))
      .where(and(eq(agentUsage.month, month), gte(agentUsage.replies, Math.ceil(this.options.agentCap * ALERT_LIMITS.agentNearShare))))
  }

  /** Conversations the agent handed over in the last day because the company's catalog did not answer. */
  private async catalogHandoffs(now: Date): Promise<AlertFacts['catalogHandoffs']> {
    const rows = await this.db
      .select({ tenantId: conversations.tenantId, count: count(), firstAt: min(conversations.handoffAt) })
      .from(conversations)
      .where(and(eq(conversations.handoffReason, 'catalog_unavailable'), gt(conversations.handoffAt, new Date(now.getTime() - DAY_MS))))
      .groupBy(conversations.tenantId)
    return rows.flatMap((r) => (r.firstAt ? [{ tenantId: r.tenantId, count: r.count, firstAt: r.firstAt }] : []))
  }

  /** Per number: its last customer message, and how many it had in the 30 days before the silence window. */
  private async inbound(now: Date): Promise<AlertFacts['inbound']> {
    const silentFrom = new Date(now.getTime() - ALERT_LIMITS.silentDays * DAY_MS).toISOString()
    const from = new Date(now.getTime() - (ALERT_LIMITS.silentDays + BASELINE_DAYS) * DAY_MS).toISOString()
    const result = await this.db.execute(sql`
      select c.channel_account_id as "channelId",
             max(m.created_at) as "lastAt",
             count(*) filter (where m.created_at <= ${silentFrom}::timestamptz)::int as "before"
        from messages m
        join conversations v on v.tenant_id = m.tenant_id and v.id = m.conversation_id
        join contacts c on c.tenant_id = v.tenant_id and c.id = v.contact_id
       where m.direction = 'in' and m.created_at > ${from}::timestamptz
       group by c.channel_account_id`)
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { channelId: string; lastAt: string | Date | null; before: number }[]
    return rows.map((r) => ({ channelId: r.channelId, lastAt: r.lastAt ? new Date(r.lastAt) : null, before: Number(r.before) }))
  }
}

// What the platform team must act on (mockup web-25), as pure rules over facts the service reads.
// Each alert carries facts, never sentences: the console writes them in Spanish.

export type AlertSeverity = 'critical' | 'warning'
export type AlertCategory = 'platform' | 'connection' | 'agent' | 'usage' | 'onboarding'
export type AlertKind =
  | 'webhooks_failed'
  | 'unroutable_number'
  | 'bcv_unread'
  | 'channel_disconnected'
  | 'foreign_app'
  | 'access_expired'
  | 'access_expiring'
  | 'number_silent'
  | 'agent_cap_reached'
  | 'agent_cap_near'
  | 'catalog_unavailable'
  | 'free_replies_exceeded'
  | 'onboarding_stalled'

export interface PlatformAlert {
  id: string
  kind: AlertKind
  severity: AlertSeverity
  category: AlertCategory
  /** Null for the platform's own problems (they touch every company). */
  tenantId: string | null
  tenantName: string | null
  channelId: string | null
  channelLabel: string | null
  /** Since when it holds (or when it will, for an access about to expire). */
  since: string | null
  facts: Record<string, string | number | null>
}

const DAY_MS = 86_400_000
export const ALERT_LIMITS = {
  accessWarningDays: 7,
  stalledOnboardingDays: 3,
  silentDays: 7,
  /** Meta's free service replies per number and month (since 2026-10-01). */
  freeReplies: 1000,
  agentNearShare: 0.8,
} as const

/** Facts the service gathers; each list is already limited to what matters. */
export interface AlertFacts {
  now: Date
  tenants: { id: string; name: string; status: string; createdAt: Date }[]
  channels: { id: string; tenantId: string; label: string; status: string; statusReason: string | null; statusChangedAt: Date | null; tokenExpiresAt: Date | null; wabaId: string; foreignApps: { id: string; name: string; firstSeenAt: string }[] }[]
  webhooksFailed: { count: number; firstAt: Date; lastError: string | null } | null
  unroutable: { key: string; count: number; lastAt: Date }[]
  bcv: { error: string; checkedAt: Date | null; rate: string | null; effectiveDate: string | null; companies: number } | null
  agentUsage: { tenantId: string; replies: number }[]
  agentCap: number
  catalogHandoffs: { tenantId: string; count: number; firstAt: Date }[]
  serviceReplies: { tenantId: string; channelId: string; count: number }[]
  inbound: { channelId: string; lastAt: Date | null; before: number }[]
}

export function platformAlerts(f: AlertFacts): PlatformAlert[] {
  const alerts: PlatformAlert[] = []
  const live = f.tenants.filter((t) => t.status !== 'cancelled')
  const tenant = new Map(live.map((t) => [t.id, t]))
  const channel = new Map(f.channels.map((c) => [c.id, c]))
  const at = (date: Date | null) => (date ? date.toISOString() : null)
  const ofTenant = (tenantId: string) => ({ tenantId, tenantName: tenant.get(tenantId)?.name ?? null })
  const ofChannel = (id: string) => {
    const c = channel.get(id)
    return { channelId: id, channelLabel: c?.label ?? null }
  }
  const none = { tenantId: null, tenantName: null, channelId: null, channelLabel: null }

  if (f.webhooksFailed) {
    alerts.push({ ...none, id: 'platform:webhooks', kind: 'webhooks_failed', severity: 'critical', category: 'platform', since: at(f.webhooksFailed.firstAt), facts: { count: f.webhooksFailed.count, lastError: f.webhooksFailed.lastError } })
  }
  for (const u of f.unroutable) {
    alerts.push({ ...none, id: `platform:unroutable:${u.key}`, kind: 'unroutable_number', severity: 'warning', category: 'platform', since: at(u.lastAt), facts: { key: u.key, count: u.count } })
  }
  if (f.bcv && f.bcv.companies > 0) {
    alerts.push({ ...none, id: 'platform:bcv', kind: 'bcv_unread', severity: 'warning', category: 'platform', since: at(f.bcv.checkedAt), facts: { error: f.bcv.error, rate: f.bcv.rate, effectiveDate: f.bcv.effectiveDate, companies: f.bcv.companies } })
  }

  for (const t of live) {
    const unfinished = t.status === 'draft' || t.status === 'awaiting_channel' || t.status === 'awaiting_owner'
    const days = Math.floor((f.now.getTime() - t.createdAt.getTime()) / DAY_MS)
    if (unfinished && days >= ALERT_LIMITS.stalledOnboardingDays) {
      alerts.push({ ...ofTenant(t.id), channelId: null, channelLabel: null, id: `${t.id}:onboarding`, kind: 'onboarding_stalled', severity: 'warning', category: 'onboarding', since: at(t.createdAt), facts: { days, waitingOwner: t.status === 'awaiting_owner' ? 1 : 0 } })
    }
  }

  for (const c of f.channels) {
    if (!tenant.has(c.tenantId)) continue
    const base = { ...ofTenant(c.tenantId), ...ofChannel(c.id), category: 'connection' as const }
    // Another app receives this number's messages (mockup web-31): a leak, whatever the number's state.
    if (c.foreignApps.length > 0) {
      const since = c.foreignApps.map((a) => a.firstSeenAt).sort()[0] ?? null
      const apps = c.foreignApps.map((a) => `${a.name || 'Sin nombre'} (${a.id})`).join(', ')
      alerts.push({ ...base, id: `${c.id}:foreign_app`, kind: 'foreign_app', severity: 'critical', since, facts: { apps, count: c.foreignApps.length, wabaId: c.wabaId } })
    }
    if (c.status === 'disconnected') {
      alerts.push({ ...base, id: `${c.id}:disconnected`, kind: 'channel_disconnected', severity: 'critical', since: at(c.statusChangedAt), facts: { reason: c.statusReason } })
      continue
    }
    if (c.tokenExpiresAt) {
      const left = Math.ceil((c.tokenExpiresAt.getTime() - f.now.getTime()) / DAY_MS)
      if (left <= 0) alerts.push({ ...base, id: `${c.id}:access`, kind: 'access_expired', severity: 'critical', since: at(c.tokenExpiresAt), facts: {} })
      else if (left <= ALERT_LIMITS.accessWarningDays) alerts.push({ ...base, id: `${c.id}:access`, kind: 'access_expiring', severity: 'warning', since: at(c.tokenExpiresAt), facts: { days: left } })
    }
  }

  // A connected number of a working company that used to hear from customers and stopped.
  for (const i of f.inbound) {
    const c = channel.get(i.channelId)
    if (!c || c.status !== 'connected' || tenant.get(c.tenantId)?.status !== 'active' || i.before === 0) continue
    if (i.lastAt && f.now.getTime() - i.lastAt.getTime() < ALERT_LIMITS.silentDays * DAY_MS) continue
    alerts.push({ ...ofTenant(c.tenantId), ...ofChannel(c.id), id: `${c.id}:silent`, kind: 'number_silent', severity: 'warning', category: 'connection', since: at(i.lastAt), facts: { perDay: Math.round(i.before / 30) } })
  }

  for (const u of f.agentUsage) {
    if (!tenant.has(u.tenantId) || f.agentCap <= 0) continue
    const base = { ...ofTenant(u.tenantId), channelId: null, channelLabel: null, category: 'agent' as const, since: null }
    if (u.replies >= f.agentCap) alerts.push({ ...base, id: `${u.tenantId}:agent`, kind: 'agent_cap_reached', severity: 'critical', facts: { replies: u.replies, cap: f.agentCap } })
    else if (u.replies >= f.agentCap * ALERT_LIMITS.agentNearShare) alerts.push({ ...base, id: `${u.tenantId}:agent`, kind: 'agent_cap_near', severity: 'warning', facts: { replies: u.replies, cap: f.agentCap } })
  }

  for (const h of f.catalogHandoffs) {
    if (!tenant.has(h.tenantId)) continue
    alerts.push({ ...ofTenant(h.tenantId), channelId: null, channelLabel: null, id: `${h.tenantId}:catalog`, kind: 'catalog_unavailable', severity: 'warning', category: 'agent', since: at(h.firstAt), facts: { conversations: h.count } })
  }

  for (const r of f.serviceReplies) {
    if (!tenant.has(r.tenantId) || r.count <= ALERT_LIMITS.freeReplies) continue
    alerts.push({ ...ofTenant(r.tenantId), ...ofChannel(r.channelId), id: `${r.channelId}:free`, kind: 'free_replies_exceeded', severity: 'warning', category: 'usage', since: null, facts: { replies: r.count, free: ALERT_LIMITS.freeReplies } })
  }

  // Critical first; inside each, the platform's own before any company's.
  const rank = (a: PlatformAlert) => (a.severity === 'critical' ? 0 : 2) + (a.tenantId ? 1 : 0)
  return alerts.sort((a, b) => rank(a) - rank(b))
}

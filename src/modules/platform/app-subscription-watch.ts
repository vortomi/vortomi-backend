import { createHash } from 'node:crypto'
import { inArray, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { channelAccounts, channelAppChecks, type SubscribedApp } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import type { MetaApp, SubscriptionReader, WabaDirectory } from '../whatsapp/cloud-api.client.ts'

/** How many numbers are read from Meta at the same time. */
const PARALLEL_READS = 4
/** A connection's own transaction commits before its number is read again. */
const DEFAULT_WAKE_DELAY_MS = 5_000

/** Structured log lines only: the server's logger. */
export interface WatchLog {
  warn(obj: object, message: string): void
  error(obj: object, message: string): void
}

interface WatchedChannel {
  id: string
  tenantId: string
  wabaId: string
}

/** What Meta answered for one number; null when it could not be read. */
type Reading = { tokenApp: MetaApp; apps: MetaApp[] } | null

export interface CheckSummary {
  checked: number
  failed: number
  /** Numbers where an app that is not ours receives the messages. */
  withForeignApps: number
}

/**
 * Reads, for every number, which apps Meta delivers its messages to (mockup web-31). Meta sends each
 * webhook to every app subscribed to the WhatsApp account, and only an app can remove itself: Vortomi
 * cannot stop a foreign app, so it finds it in minutes and the console raises a critical alert.
 *
 * Ours are the apps the stored tokens belong to, plus the Embedded Signup app: nothing to configure.
 * Runs on the server connection (channel_app_checks is platform data) and logs no token.
 */
export class AppSubscriptionWatch {
  private running: Promise<unknown> | null = null
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The app of each token, by the token's SHA-256: a token's app never changes. */
  private readonly tokenApps = new Map<string, MetaApp>()

  constructor(
    private readonly db: Database,
    private readonly credentials: Pick<ChannelCredentials, 'accessTokenFor'>,
    private readonly reader: SubscriptionReader,
    private readonly options: {
      /** Apps that are ours even when no stored token belongs to them (the Embedded Signup app). */
      ourAppIds: readonly string[]
      log: WatchLog
      now?: () => Date
      wakeDelayMs?: number
    },
  ) {}

  /** A number was just connected or changed: every number is read again shortly. */
  wake(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.run()
    }, this.options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS)
    this.timer.unref?.()
  }

  /** Reads every number now; a call while a read runs makes one more afterwards. */
  run(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = this.checkAll()
      .then((summary) => {
        if (summary.withForeignApps > 0) this.options.log.warn(summary, 'Foreign apps receive the messages of some numbers')
      })
      .catch((error: unknown) => this.options.log.error({ err: error }, 'App subscription check failed'))
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          this.run()
        }
      })
  }

  /** Resolves when no read is pending or in progress (shutdown, tests). */
  async idle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.running) await this.running
  }

  async checkAll(): Promise<CheckSummary> {
    const channels: WatchedChannel[] = await this.db.select({ id: channelAccounts.id, tenantId: channelAccounts.tenantId, wabaId: channelAccounts.wabaId }).from(channelAccounts)
    if (channels.length === 0) return { checked: 0, failed: 0, withForeignApps: 0 }

    const readings = new Map<string, Reading>()
    for (let i = 0; i < channels.length; i += PARALLEL_READS) {
      const batch = channels.slice(i, i + PARALLEL_READS)
      const results = await Promise.all(batch.map((channel) => this.read(channel)))
      batch.forEach((channel, index) => readings.set(channel.id, results[index] ?? null))
    }

    const ours = new Set(this.options.ourAppIds)
    for (const reading of readings.values()) if (reading) ours.add(reading.tokenApp.id)

    const previous = await this.db
      .select({ channelAccountId: channelAppChecks.channelAccountId, apps: channelAppChecks.apps })
      .from(channelAppChecks)
      .where(inArray(channelAppChecks.channelAccountId, channels.map((c) => c.id)))
    const seenBefore = new Map(previous.map((row) => [row.channelAccountId, row.apps ?? []]))

    const now = (this.options.now?.() ?? new Date()).toISOString()
    const summary: CheckSummary = { checked: 0, failed: 0, withForeignApps: 0 }
    for (const channel of channels) {
      const reading = readings.get(channel.id) ?? null
      if (!reading) {
        summary.failed++
        await this.db
          .insert(channelAppChecks)
          .values({ channelAccountId: channel.id, tenantId: channel.tenantId, failedAt: new Date(now) })
          .onConflictDoUpdate({ target: channelAppChecks.channelAccountId, set: { failedAt: new Date(now) } })
        continue
      }
      const firstSeen = new Map((seenBefore.get(channel.id) ?? []).map((app) => [app.id, app.firstSeenAt]))
      const apps: SubscribedApp[] = reading.apps.map((app) => ({ id: app.id, name: app.name, ours: ours.has(app.id), firstSeenAt: firstSeen.get(app.id) ?? now }))
      summary.checked++
      if (apps.some((app) => !app.ours)) summary.withForeignApps++
      await this.db
        .insert(channelAppChecks)
        .values({ channelAccountId: channel.id, tenantId: channel.tenantId, apps, checkedAt: new Date(now), failedAt: null })
        .onConflictDoUpdate({ target: channelAppChecks.channelAccountId, set: { apps: sql`excluded.apps`, checkedAt: new Date(now), failedAt: null } })
    }
    return summary
  }

  private async read(channel: WatchedChannel): Promise<Reading> {
    try {
      const token = await this.credentials.accessTokenFor(channel.tenantId, channel.id)
      if (!token) return null
      const key = createHash('sha256').update(token).digest('hex')
      let tokenApp = this.tokenApps.get(key)
      if (!tokenApp) {
        tokenApp = await this.reader.tokenApp(token)
        this.tokenApps.set(key, tokenApp)
      }
      return { tokenApp, apps: await this.reader.subscribedApps(channel.wabaId, token) }
    } catch (error) {
      // Meta's message and code only (WhatsAppApiError never carries the token).
      this.options.log.warn({ channelId: channel.id, reason: error instanceof Error ? error.message : 'unknown' }, 'App subscriptions could not be read')
      return null
    }
  }
}

/**
 * The same directory, but every subscription of our app to an account (console connection, number
 * change, «Conectar con WhatsApp») has the numbers read again: a foreign app shows up right away.
 */
export function watchingSubscriptions(directory: WabaDirectory, watch: Pick<AppSubscriptionWatch, 'wake'>): WabaDirectory {
  return {
    listNumbers: (wabaId, token) => directory.listNumbers(wabaId, token),
    businessVerification: (wabaId, token) => directory.businessVerification(wabaId, token),
    subscribeApp: async (wabaId, token) => {
      await directory.subscribeApp(wabaId, token)
      watch.wake()
    },
    numberDetails: (phoneNumberId, token) => directory.numberDetails(phoneNumberId, token),
    registerNumber: (phoneNumberId, token, pin) => directory.registerNumber(phoneNumberId, token, pin),
    requestAppDataSync: (phoneNumberId, token, kind) => directory.requestAppDataSync(phoneNumberId, token, kind),
  }
}

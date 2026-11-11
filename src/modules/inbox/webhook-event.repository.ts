import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { webhookEvents } from '../../db/schema/index.ts'

export interface StoredWebhookEvent {
  id: number
  payload: unknown
}

export class WebhookEventRepository {
  constructor(private readonly db: Database) {}

  async insert(payload: unknown): Promise<number> {
    const [row] = await this.db.insert(webhookEvents).values({ payload }).returning({ id: webhookEvents.id })
    if (!row) throw new Error('Webhook event insert returned no row')
    return row.id
  }

  async findById(id: number): Promise<StoredWebhookEvent | null> {
    const [row] = await this.db
      .select({ id: webhookEvents.id, payload: webhookEvents.payload })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.id, id), isNull(webhookEvents.processedAt)))
      .limit(1)
    return row ?? null
  }

  /**
   * Unprocessed events older than `olderThan`, oldest first, below the attempt limit. With a
   * `backoffMs`, each failed attempt waits longer before the next (×4: 30 s, 2 min, 8 min, 32 min,
   * 2 h, 8.5 h with 30 s), so an outage of hours does not use up every attempt in minutes.
   */
  async findPendingIds(olderThan: Date, maxAttempts: number, limit: number, backoffMs = 0): Promise<number[]> {
    const rows = await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          isNull(webhookEvents.processedAt),
          lt(webhookEvents.receivedAt, olderThan),
          lt(webhookEvents.attempts, maxAttempts),
          backoffMs > 0
            ? sql`${webhookEvents.receivedAt} < ${olderThan}::timestamptz - make_interval(secs => ${backoffMs / 1000} * (power(4, ${webhookEvents.attempts}) - 1))`
            : undefined,
        ),
      )
      .orderBy(asc(webhookEvents.receivedAt))
      .limit(limit)
    return rows.map((row) => row.id)
  }

  async markProcessed(id: number, note: string | null): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ processedAt: new Date(), attempts: sql`${webhookEvents.attempts} + 1`, lastError: note })
      .where(eq(webhookEvents.id, id))
  }

  /** Counts the attempt; resolves to how many there have been. */
  async markFailed(id: number, error: string): Promise<number> {
    const [row] = await this.db
      .update(webhookEvents)
      .set({ attempts: sql`${webhookEvents.attempts} + 1`, lastError: error.slice(0, 2000) })
      .where(eq(webhookEvents.id, id))
      .returning({ attempts: webhookEvents.attempts })
    return row?.attempts ?? 0
  }

  /** Deletes processed events older than `before` (their effects live in the company's tables), a batch at a time. */
  async purgeProcessed(before: Date, batch = 1000): Promise<number> {
    const old = this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(lt(webhookEvents.processedAt, before))
      .limit(batch)
    const deleted = await this.db.delete(webhookEvents).where(inArray(webhookEvents.id, old)).returning({ id: webhookEvents.id })
    return deleted.length
  }
}

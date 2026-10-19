import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
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

  /** Unprocessed events older than `olderThan`, oldest first, below the attempt limit. */
  async findPendingIds(olderThan: Date, maxAttempts: number, limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          isNull(webhookEvents.processedAt),
          lt(webhookEvents.receivedAt, olderThan),
          lt(webhookEvents.attempts, maxAttempts),
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

  async markFailed(id: number, error: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ attempts: sql`${webhookEvents.attempts} + 1`, lastError: error.slice(0, 2000) })
      .where(eq(webhookEvents.id, id))
  }
}

import type { WebhookEventRepository } from './webhook-event.repository.ts'
import type { SerialQueue } from './serial-queue.ts'

export interface InboxOptions {
  /** Retry budget per webhook before it is left for a person to inspect. */
  maxAttempts: number
  /** Only events older than this are swept, so fresh ones are not picked twice. */
  sweepGraceMs: number
  sweepBatchSize: number
}

/**
 * Entry point for verified webhooks: store first, then schedule. The recovery
 * sweep re-schedules whatever a crash or a failure left unprocessed.
 */
export class WebhookInbox {
  constructor(
    private readonly repository: WebhookEventRepository,
    private readonly queue: SerialQueue,
    private readonly options: InboxOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(payload: unknown): Promise<number> {
    const id = await this.repository.insert(payload)
    this.queue.push(id)
    return id
  }

  async sweep(): Promise<number> {
    const olderThan = new Date(this.now().getTime() - this.options.sweepGraceMs)
    const ids = await this.repository.findPendingIds(olderThan, this.options.maxAttempts, this.options.sweepBatchSize)
    return ids.filter((id) => this.queue.push(id)).length
  }
}

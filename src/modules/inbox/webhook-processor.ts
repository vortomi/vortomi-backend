import { type ParseResult, type WhatsAppEvent, eventIdOf, routingKeyOf } from '../whatsapp/events.ts'
import type { WebhookEventRepository } from './webhook-event.repository.ts'

/** 'unroutable': the event's number belongs to no company on the platform. */
export type EventOutcome = 'handled' | 'unroutable'

export interface WhatsAppEventHandler {
  handle(event: WhatsAppEvent): Promise<EventOutcome>
}

export interface ProcessorLogger {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * Turns one stored webhook into domain changes. Handlers are idempotent, so a
 * failed webhook is simply retried whole: what already succeeded is a no-op.
 */
export class WebhookProcessor {
  constructor(
    private readonly repository: WebhookEventRepository,
    private readonly parse: (payload: unknown) => ParseResult,
    private readonly handler: WhatsAppEventHandler,
    private readonly log: ProcessorLogger,
  ) {}

  async process(webhookEventId: number): Promise<void> {
    const stored = await this.repository.findById(webhookEventId)
    if (!stored) return // already processed by an earlier run

    const { events, skipped } = this.parse(stored.payload)
    if (skipped.length > 0) this.log.warn({ webhookEventId, skipped }, 'Webhook items skipped')

    const failures: string[] = []
    const unroutable = new Set<string>()
    for (const event of events) {
      try {
        if ((await this.handler.handle(event)) === 'unroutable') unroutable.add(routingKeyOf(event))
      } catch (error) {
        // Keep going: one bad event must not block the rest of the batch.
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${event.kind} ${eventIdOf(event)}: ${message}`)
        this.log.error({ webhookEventId, kind: event.kind, err: message }, 'Webhook event failed')
      }
    }

    if (failures.length > 0) {
      await this.repository.markFailed(webhookEventId, failures.join('; '))
      return
    }

    // Not retried: a number nobody owns will not become someone's by retrying. The
    // payload stays in webhook_events, with this note, for a person to inspect.
    if (unroutable.size > 0) {
      this.log.warn({ webhookEventId, routingKeys: [...unroutable] }, 'Events for numbers or accounts no company owns')
    }
    const notes = [
      ...(skipped.length > 0 ? [`skipped: ${skipped.join(', ')}`] : []),
      ...(unroutable.size > 0 ? [`unroutable: ${[...unroutable].join(', ')}`] : []),
    ]
    await this.repository.markProcessed(webhookEventId, notes.length > 0 ? notes.join('; ') : null)
  }
}

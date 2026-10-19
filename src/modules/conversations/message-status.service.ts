import { eq } from 'drizzle-orm'
import type { DeliveryStatus } from '../../db/schema/enums.ts'
import { messageDeliveryStatus, messageStatusEvents } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { StatusUpdateEvent } from '../whatsapp/events.ts'

export type StatusRecordOutcome = 'recorded' | 'duplicate'

/**
 * Delivery statuses as an append-only log (design document 8.3): each status Meta
 * reports is one row, never an UPDATE. The current status is derived by the view
 * message_delivery_status, so arrival order does not matter ("read" may come before
 * "delivered") and nothing is lost when a status arrives before its message.
 */
export class MessageStatusService {
  async record(scope: TenantScope, event: StatusUpdateEvent): Promise<StatusRecordOutcome> {
    const inserted = await scope.tx
      .insert(messageStatusEvents)
      .values({
        tenantId: scope.tenantId,
        waMessageId: event.waMessageId,
        status: event.status,
        occurredAt: event.timestamp,
        pricingCategory: event.pricing?.category ?? null,
        billable: event.pricing?.billable ?? null,
        errorText: event.errorText,
      })
      .onConflictDoNothing({
        target: [messageStatusEvents.tenantId, messageStatusEvents.waMessageId, messageStatusEvents.status],
      })
      .returning({ id: messageStatusEvents.id })
    return inserted.length > 0 ? 'recorded' : 'duplicate'
  }

  /** Furthest status reached, or null when Meta has reported nothing yet. */
  async current(scope: TenantScope, waMessageId: string): Promise<DeliveryStatus | null> {
    const [row] = await scope.tx
      .select({ status: messageDeliveryStatus.status })
      .from(messageDeliveryStatus)
      .where(eq(messageDeliveryStatus.waMessageId, waMessageId))
      .limit(1)
    return row?.status ?? null
  }
}

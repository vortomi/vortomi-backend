import type { Database } from '../../db/client.ts'
import type { IngestService } from '../conversations/ingest.service.ts'
import type { MessageStatusService } from '../conversations/message-status.service.ts'
import type { AwayReplyService } from '../messaging/away-reply.ts'
import type { TemplateService } from '../templates/template-service.ts'
import type { ChannelDirectory } from '../tenancy/channel-directory.ts'
import { withTenant } from '../tenancy/tenant-scope.ts'
import type { NumberEvent, TemplateStatusEvent, WhatsAppEvent } from '../whatsapp/events.ts'
import type { EventOutcome, WhatsAppEventHandler } from './webhook-processor.ts'

/**
 * Routes each event to the company that owns it and hands it to the service that owns
 * the event kind, inside that company's scope. Message events are routed by their
 * number (phone_number_id); template events by their WhatsApp Business Account.
 * One webhook can carry events of several numbers: each one is routed on its own.
 */
export class EventRouter implements WhatsAppEventHandler {
  constructor(
    private readonly db: Database,
    private readonly channels: ChannelDirectory,
    private readonly ingest: IngestService,
    private readonly statuses: MessageStatusService,
    private readonly templates: Pick<TemplateService, 'applyStatus'>,
    // Optional so tests about routing need no Meta double; main.ts always passes it.
    private readonly awayReply: Pick<AwayReplyService, 'afterInbound'> | null = null,
  ) {}

  handle(event: WhatsAppEvent): Promise<EventOutcome> {
    return event.kind === 'template_status' ? this.handleTemplate(event) : this.handleNumberEvent(event)
  }

  private async handleNumberEvent(event: NumberEvent): Promise<EventOutcome> {
    const route = await this.channels.resolve(event.phoneNumberId)
    // No company owns this number: set it aside. Guessing would be a data leak.
    if (!route) return 'unroutable'

    const inbound = await withTenant(this.db, route.tenantId, async (scope) => {
      switch (event.kind) {
        case 'inbound_message':
          return this.ingest.recordInbound(scope, route.channelAccountId, event)
        case 'status_update':
          await this.statuses.record(scope, event)
          return null
      }
    })
    // After the commit: the customer's message is stored whatever happens with the answer.
    if (inbound?.isNew && event.kind === 'inbound_message') {
      await this.awayReply?.afterInbound(route.tenantId, { conversationId: inbound.conversationId, waMessageId: event.waMessageId, timestamp: event.timestamp })
    }
    return 'handled'
  }

  private async handleTemplate(event: TemplateStatusEvent): Promise<EventOutcome> {
    const tenantId = await this.channels.resolveWaba(event.wabaId)
    if (!tenantId) return 'unroutable'
    await withTenant(this.db, tenantId, (scope) => this.templates.applyStatus(scope, event))
    return 'handled'
  }
}

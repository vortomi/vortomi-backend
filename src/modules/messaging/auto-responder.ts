import type { FastifyBaseLogger } from 'fastify'
import type { SalesAgent } from '../agent/sales-agent.ts'
import type { ReceiptCollector } from '../orders/receipt-collector.ts'
import type { AwayReplyService, InboundTrigger } from './away-reply.ts'

/**
 * Who answers a new customer message by itself: a payment receipt for a pending order goes to that
 * order; otherwise the sales agent while its company keeps it on (it covers the closed hours too),
 * otherwise the away message when the company is closed. A company that is not working (suspended or
 * cancelled from the console) answers nothing: its messages are stored for when it comes back.
 */
export class AutoResponder {
  constructor(
    private readonly agent: Pick<SalesAgent, 'takes'>,
    private readonly awayReply: Pick<AwayReplyService, 'afterInbound'>,
    private readonly log: Pick<FastifyBaseLogger, 'error'>,
    private readonly receipts: Pick<ReceiptCollector, 'takes'> | null = null,
    private readonly isActive: (tenantId: string) => Promise<boolean> = () => Promise.resolve(true),
  ) {}

  /** Runs after a NEW customer message is stored. Never throws: that message is already safe. */
  async afterInbound(tenantId: string, trigger: InboundTrigger): Promise<void> {
    try {
      if (!(await this.isActive(tenantId))) return
    } catch (error) {
      // Not knowing is not a reason to answer for a company that may be closed.
      this.log.error({ err: error, tenantId }, 'Company status check failed')
      return
    }
    try {
      if (await this.receipts?.takes(tenantId, trigger)) return
    } catch (error) {
      this.log.error({ err: error, tenantId, conversationId: trigger.conversationId }, 'Payment receipt check failed')
    }
    try {
      if (await this.agent.takes(tenantId, trigger)) return
    } catch (error) {
      this.log.error({ err: error, tenantId, conversationId: trigger.conversationId }, 'Sales agent check failed')
    }
    await this.awayReply.afterInbound(tenantId, trigger)
  }
}

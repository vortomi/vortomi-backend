import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../../db/client.ts'
import type { HandoffReason } from '../../db/schema/enums.ts'
import { agentSettings, agentUsage, conversationAssignees, conversations, exchangeRates, messages, tenantSettings, tenants } from '../../db/schema/index.ts'
import type { InboundTrigger } from '../messaging/away-reply.ts'
import { type BotDelivery, type BotDraft, type BotTarget, botMessageId, findTarget, storeBotText } from '../messaging/bot-delivery.ts'
import { isOpenAt } from '../messaging/business-hours.ts'
import { type TenantScope, withTenant } from '../tenancy/tenant-scope.ts'
import { type PromptFacts, orderLineText, systemPrompt } from './agent-prompt.ts'
import { type AgentCatalog, externalCatalog, inventoryCatalog } from './agent-catalog.ts'
import { type AgentIntent, type OrderDesk, agentTools, handOffTool } from './agent-tools.ts'
import { dayIn } from '../../shared/time-zone.ts'
import { OrderService } from '../orders/order-service.ts'
import type { CatalogSources } from '../catalog-source/catalog-sources.ts'
import { DeliveryService } from '../delivery/delivery-service.ts'
import type { OrderQuote } from '../orders/order-quote.ts'
import { paymentMessage } from '../payment-methods/payment-message.ts'
import { PaymentMethodService } from '../payment-methods/payment-method-service.ts'
import type { ChatModel, ChatRequest, ChatTurn } from './chat-model.ts'

/** A message stored later than this (recovered after an outage) gets no automatic answer. */
const FRESH_MS = 10 * 60_000
/** Someone of the team wrote in the conversation this recently: they are attending it. */
const TEAM_ACTIVE_MS = 60 * 60_000
/** How much of the conversation the model reads. */
const HISTORY = 20

export interface SalesAgentOptions {
  /** Answers per company and month; past it, conversations go to a person. */
  monthlyCap: number
  /** Waits this long after a customer message, so several quick messages get one answer. */
  debounceMs: number
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>
  /** Companies whose catalog lives in their own system; without it, every company uses its inventory. */
  catalogs?: Pick<CatalogSources, 'lookup'>
  now?: () => Date
}

/** Everything one answer needs, read in one transaction; null when the agent must stay quiet. */
interface Context {
  facts: PromptFacts
  history: ChatTurn[]
  /** What the customer wrote since the business last answered: searched in the catalog before asking. */
  customerText: string
  target: BotTarget
  /** The customer message being answered: the answer's id comes from it. */
  waMessageId: string
  /** With its own catalog system: price in bolívares at that system's rate (else at facts.bsPerUsd). */
  useSystemRate: boolean
  /** An order the agent took is in progress: it only tells how it is going (no catalog, no new orders). */
  followUp: boolean
}

/**
 * The sales agent: while a company keeps it on, it answers its customers by itself. It reads
 * that conversation and the company's public data only, looks products up, and passes the chat to
 * a person when the customer wants to buy, asks for one, or it does not know. It stays quiet where
 * a person is in charge: assigned conversations, a recent team message, or a pending hand-off. While
 * an order it took is in progress it only tells how that order is going and passes anything else on.
 */
export class SalesAgent {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => Date

  constructor(
    private readonly db: Database,
    private readonly delivery: BotDelivery,
    private readonly model: ChatModel | null,
    private readonly options: SalesAgentOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Whether this company's agent answers now. If so it takes the message (answering a moment
   * later) and nothing else replies automatically; if not, the away message may.
   */
  async takes(tenantId: string, trigger: InboundTrigger): Promise<boolean> {
    if (!this.model) return false
    const on = await withTenant(this.db, tenantId, (scope) => this.isOn(scope, trigger.timestamp))
    if (!on) return false
    if (this.now().getTime() - trigger.timestamp.getTime() <= FRESH_MS) this.schedule(tenantId, trigger.conversationId)
    return true
  }

  /** Answers the conversation now, if it still should. Never throws: a failure goes to a person. */
  async answer(tenantId: string, conversationId: string): Promise<void> {
    try {
      const context = await withTenant(this.db, tenantId, (scope) => this.context(scope, conversationId))
      if (!context || !this.model) return
      // The customer sees "escribiendo…" while the model works (the free tier takes 20-30 s).
      void this.delivery.showTyping(tenantId, context.target, context.waMessageId)
      const intent: AgentIntent = { handoff: null, placed: null }
      const reply = await this.model.reply(
        context.followUp
          ? { system: systemPrompt(context.facts), history: context.history, tools: [handOffTool(intent)] }
          : await this.sellingRequest(tenantId, conversationId, context, intent),
      )
      // A just-placed order is answered with one message the server writes: how to pay it.
      const body = (intent.placed && paymentBody(intent.placed.quote)) || reply.text
      const draft = await withTenant(this.db, tenantId, async (scope) => {
        const answer = await this.store(scope, context.target, conversationId, botMessageId('sales-agent', context.waMessageId), body)
        if (intent.handoff) await this.handOff(scope, conversationId, intent.handoff)
        await this.count(scope, reply.usage)
        return answer
      })
      if (draft) await this.delivery.deliver(tenantId, draft)
    } catch (error) {
      this.options.log.error({ err: error, tenantId, conversationId }, 'Sales agent failed; passed to a person')
      await withTenant(this.db, tenantId, (scope) => this.handOff(scope, conversationId, 'agent_error')).catch(() => undefined)
    }
  }

  /** The full agent: the catalog searched beforehand, and orders it may quote and save. */
  private async sellingRequest(tenantId: string, conversationId: string, context: Context, intent: AgentIntent): Promise<ChatRequest> {
    // Searching first usually saves the model a second round trip (one call instead of two).
    const catalog = await this.catalogFor(tenantId, context.facts.bsPerUsd, context.useSystemRate)
    const found = await catalog.forPrompt(context.customerText)
    // A confirmed order is saved in its own transaction, once per customer message.
    const desk: OrderDesk | null = context.facts.delivery
      ? {
          terms: { delivery: context.facts.delivery, paymentMethods: context.facts.paymentMethods ?? [] },
          place: (quote) => withTenant(this.db, tenantId, (scope) => new OrderService().place(scope, conversationId, `agent:${context.waMessageId}`, quote)),
        }
      : null
    return {
      system: systemPrompt({ ...context.facts, bsPerUsd: catalog.bsPerUsd, catalog: found.products.length || found.note ? JSON.stringify(found) : undefined }),
      history: context.history,
      tools: agentTools(catalog, intent, desk),
    }
  }

  /**
   * The company's own system when it has one connected, priced at its rate or the company's one
   * («Usar la tasa de mi sistema»); Vortomi's inventory otherwise.
   */
  private async catalogFor(tenantId: string, companyRate: string | null, useSystemRate: boolean): Promise<AgentCatalog> {
    const lookup = (await this.options.catalogs?.lookup(tenantId)) ?? { source: 'inventory' as const }
    if (lookup.source === 'inventory') return inventoryCatalog(this.db, tenantId, companyRate)
    return externalCatalog(lookup.catalog, useSystemRate ? { from: 'system' } : { from: 'company', bsPerUsd: companyRate })
  }

  private schedule(tenantId: string, conversationId: string): void {
    clearTimeout(this.timers.get(conversationId))
    this.timers.set(
      conversationId,
      setTimeout(() => {
        this.timers.delete(conversationId)
        void this.answer(tenantId, conversationId)
      }, this.options.debounceMs),
    )
  }

  private async isOn(scope: TenantScope, at: Date): Promise<boolean> {
    const [row] = await scope.tx
      .select({ enabled: agentSettings.enabled, schedule: agentSettings.schedule, hours: tenantSettings.businessHours, timezone: tenants.timezone })
      .from(agentSettings)
      .innerJoin(tenants, eq(tenants.id, agentSettings.tenantId))
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, agentSettings.tenantId))
      .where(eq(agentSettings.tenantId, scope.tenantId))
    if (!row?.enabled) return false
    return row.schedule === 'always' || !isOpenAt(row.hours ?? [], at, row.timezone)
  }

  private async context(scope: TenantScope, conversationId: string): Promise<Context | null> {
    const { tx, tenantId } = scope
    const [conversation] = await tx
      .select({ handoffReason: conversations.handoffReason, status: conversations.status })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    if (!conversation || conversation.status !== 'open') return null
    // Handed off for an order it took, it still tells how the order is going; for anything else it is quiet.
    const followUp = conversation.handoffReason === 'order_placed'
    if (conversation.handoffReason && !followUp) return null
    const [assigned] = await tx
      .select({ userId: conversationAssignees.userId })
      .from(conversationAssignees)
      .where(and(eq(conversationAssignees.tenantId, tenantId), eq(conversationAssignees.conversationId, conversationId)))
      .limit(1)
    if (assigned) return null

    const recent = await tx
      .select({ direction: messages.direction, author: messages.author, type: messages.type, body: messages.body, waMessageId: messages.waMessageId, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.id))
      .limit(HISTORY)
    const last = recent[0]
    // Only a customer message waiting for an answer; and never over a person who just wrote.
    if (!last || last.direction !== 'in' || !last.waMessageId) return null
    const teamSince = new Date(this.now().getTime() - TEAM_ACTIVE_MS)
    if (recent.some((m) => m.author === 'staff' && m.createdAt > teamSince)) return null

    const [usage] = await tx
      .select({ replies: agentUsage.replies })
      .from(agentUsage)
      .where(and(eq(agentUsage.tenantId, tenantId), eq(agentUsage.month, monthOf(this.now()))))
    if ((usage?.replies ?? 0) >= this.options.monthlyCap) {
      await this.handOff(scope, conversationId, 'limit_reached')
      return null
    }

    const [company] = await tx
      .select({ name: tenants.name, timezone: tenants.timezone, hours: tenantSettings.businessHours, useSystemRate: tenantSettings.useSystemRate, assistantName: agentSettings.assistantName, tone: agentSettings.tone, businessInfo: agentSettings.businessInfo })
      .from(tenants)
      .innerJoin(agentSettings, eq(agentSettings.tenantId, tenants.id))
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId))
    if (!company) return null
    const [rate] = await tx
      .select({ rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(eq(exchangeRates.tenantId, tenantId))
      .orderBy(desc(exchangeRates.createdAt))
      .limit(1)
    const target = await findTarget(tx, tenantId, conversationId)
    if (!target) return null
    const hours = company.hours ?? []
    const firstAnswered = recent.findIndex((m) => m.direction === 'out')
    return {
      facts: {
        companyName: company.name,
        assistantName: company.assistantName,
        tone: company.tone,
        businessInfo: company.businessInfo,
        hours,
        openNow: isOpenAt(hours, this.now(), company.timezone),
        bsPerUsd: rate ? Number(rate.rate).toFixed(2) : null,
        firstReply: firstAnswered < 0,
        delivery: await new DeliveryService().view(scope),
        paymentMethods: await new PaymentMethodService().list(scope, { visibleOnly: true }),
        orders: (await new OrderService().recentFor(scope, conversationId)).map((o) => ({
          status: o.status,
          fulfillment: o.fulfillment,
          items: o.lines.map(orderLineText).join(', '),
          placedOn: dayIn(o.createdAt, company.timezone),
        })),
        followUp,
      },
      history: [...recent].reverse().map((m) => ({ from: m.direction === 'in' ? 'customer' : 'business', text: m.body?.trim() || `[${m.type}]` })),
      customerText: (firstAnswered < 0 ? recent : recent.slice(0, firstAnswered)).map((m) => m.body ?? '').join(' '),
      target,
      waMessageId: last.waMessageId,
      useSystemRate: company.useSystemRate ?? true,
      followUp,
    }
  }

  private async store(scope: TenantScope, target: BotTarget, conversationId: string, clientMessageId: string, body: string): Promise<BotDraft | null> {
    const messageId = await storeBotText(scope.tx, scope.tenantId, conversationId, clientMessageId, body)
    return messageId === null ? null : { messageId, ...target, body }
  }

  /** Keeps the first reason, except an order's follow-up: anything past it goes fully to a person. */
  private async handOff(scope: TenantScope, conversationId: string, reason: HandoffReason): Promise<void> {
    await scope.tx
      .update(conversations)
      .set({ handoffAt: sql`now()`, handoffReason: reason })
      .where(
        and(
          eq(conversations.tenantId, scope.tenantId),
          eq(conversations.id, conversationId),
          sql`(${conversations.handoffAt} is null or ${conversations.handoffReason} = 'order_placed')`,
        ),
      )
  }

  private async count(scope: TenantScope, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    await scope.tx
      .insert(agentUsage)
      .values({ tenantId: scope.tenantId, month: monthOf(this.now()), replies: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
      .onConflictDoUpdate({
        target: [agentUsage.tenantId, agentUsage.month],
        set: {
          replies: sql`${agentUsage.replies} + 1`,
          inputTokens: sql`${agentUsage.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${agentUsage.outputTokens} + ${usage.outputTokens}`,
        },
      })
  }
}

/** The payment message of a placed order; null when it has no method (the model's own words go). */
function paymentBody(quote: OrderQuote): string | null {
  if (!quote.paymentMethod) return null
  return paymentMessage(quote.paymentMethod, {
    customerName: quote.request.customerName,
    totalCents: quote.subtotalCents + (quote.deliveryCents ?? 0),
    deliveryPending: quote.request.fulfillment === 'delivery' && quote.deliveryCents === null,
    bsPerUsd: quote.bsPerUsd,
  })
}

/** First day of the month in UTC, the key of agent_usage. */
export const monthOf = (at: Date) => `${at.toISOString().slice(0, 7)}-01`

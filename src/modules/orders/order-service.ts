import { randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Fulfillment, ORDER_STATUSES, type OrderStatus, type PaymentMethodType, type SaleUnit } from '../../db/schema/enums.ts'
import { contacts, conversations, mediaFiles, orderLines, orderReceipts, orders, paymentMethods, saleReceipts, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { returnToAgent } from '../conversations/agent-handoff.ts'
import { visibleConversations } from '../conversations/visibility.ts'
import { type PaymentCurrency, currencyOf } from '../payment-methods/payment-method-types.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { OrderQuote } from './order-quote.ts'
import { type StockShortfall, giveBackStock, takeStock } from './order-stock.ts'
import { type PaymentAlerts, paymentAlerts } from './payment-alerts.ts'
import { type PaymentCheck, SOLD, checkPaymentProof, expectedAmount } from './payment-proof.ts'

export class OrderNotFoundError extends Error {
  constructor() {
    super('Order not found or not visible')
    this.name = 'OrderNotFoundError'
  }
}

/** "P-7K3F9Q": short enough to read out on the phone, without look-alike letters. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const newCode = () => `P-${[...randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`

export interface OrderView {
  id: string
  code: string
  status: OrderStatus
  conversationId: string
  contactName: string | null
  customerName: string
  fulfillment: Fulfillment
  zone: string | null
  address: string | null
  paymentMethod: { id: string; name: string; type: PaymentMethodType; currency: PaymentCurrency } | null
  notes: string
  /** The bank reference of the payment, typed by whoever checked it. */
  paymentReference: string | null
  /** What arrived, in the payment method's currency (dollars without a method), as the person wrote it. */
  receivedAmount: string | null
  /** When and by whom the payment was confirmed; null while it is not sold (or for a person who left). */
  confirmedAt: Date | null
  confirmedBy: string | null
  lines: { name: string; quantity: number; saleUnit: SaleUnit; unitPriceCents: number }[]
  subtotalCents: number
  deliveryCents: number | null
  bsPerUsd: string | null
  receiptCount: number
  createdAt: Date
}

/** An order as the customer knows it: no code, no amounts (the agent never quotes them again). */
export interface RecentOrder {
  status: OrderStatus
  fulfillment: Fulfillment
  lines: { name: string; quantity: number; saleUnit: SaleUnit }[]
  createdAt: Date
}

/** One order with the payment receipts the customer sent (the files come one by one) and the sale receipt it got. */
export interface OrderDetail extends OrderView {
  receipts: { mediaId: string; mimeType: string; sizeBytes: number; createdAt: Date }[]
  /** Null until the order is completed (or when the company gives no receipts). Code null: the team's own. */
  saleReceipt: { code: string | null; createdAt: Date } | null
  /** What should arrive, in the payment method's currency; null when it cannot be known. */
  expectedAmount: string | null
  alerts: PaymentAlerts
}

export interface OrderFilters {
  status?: OrderStatus
  conversationId?: string
  orderId?: string
  /** Sold orders confirmed on that day ("2026-11-10") of the company's clock. */
  soldOn?: { date: string; timezone: string }
}

/** What changed when an order became sold: products the inventory did not have enough of. */
export interface SaleOutcome {
  stockShortfalls: StockShortfall[]
}

/** Confirming goes through its own action: the customer is told (order-confirmation.ts). */
export const orderStatusInput = z.object({ status: z.enum(ORDER_STATUSES.filter((s) => s !== 'confirmed') as [OrderStatus, ...OrderStatus[]]) })

/** Statuses an order can be confirmed from. */
const CONFIRMABLE: OrderStatus[] = ['awaiting_payment', 'payment_review']
/** Nothing left for a person to do. */
const CLOSED: OrderStatus[] = ['done', 'cancelled']

/** The order's conversation is one the person sees. */
const visibleOrder = (scope: MemberScope) =>
  sql`exists (select 1 from ${conversations} where ${conversations.tenantId} = ${orders.tenantId} and ${conversations.id} = ${orders.conversationId} and ${visibleConversations(scope.member) ?? sql`true`})`

/** Orders of a company: placed by the agent, read and moved along by the team. */
export class OrderService {
  /**
   * Saves a priced order once per source (the customer message it answers); the same source again
   * returns it. It waits for the payment, unless its method takes no proof (cash): then a person reviews it.
   */
  async place(scope: TenantScope, conversationId: string, sourceKey: string, quote: OrderQuote): Promise<{ id: string; code: string }> {
    const { tx, tenantId } = scope
    const [existing] = await tx.select({ id: orders.id, code: orders.code }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.sourceKey, sourceKey)))
    if (existing) return existing
    const r = quote.request
    const method = quote.paymentMethod
    const waitsForProof = method !== null && (method.receiptRule !== 'none' || method.referenceRule !== 'none')
    const [order] = await tx
      .insert(orders)
      .values({
        tenantId,
        conversationId,
        code: newCode(),
        status: waitsForProof ? 'awaiting_payment' : 'payment_review',
        sourceKey,
        customerName: r.customerName,
        fulfillment: r.fulfillment,
        zone: r.fulfillment === 'delivery' ? (r.zone ?? null) : null,
        address: r.fulfillment === 'delivery' ? (r.address ?? null) : null,
        paymentMethodId: method?.id ?? null,
        notes: r.notes ?? '',
        subtotalCents: quote.subtotalCents,
        deliveryCents: quote.deliveryCents,
        bsPerUsd: quote.bsPerUsd,
      })
      .returning({ id: orders.id, code: orders.code })
    await tx.insert(orderLines).values(quote.lines.map((line, position) => ({ tenantId, orderId: order!.id, position, ...line })))
    return order!
  }

  /** The latest orders of a conversation, newest first: what the agent may tell the customer about them. */
  async recentFor(scope: TenantScope, conversationId: string, limit = 3): Promise<RecentOrder[]> {
    const rows = await scope.tx
      .select({ id: orders.id, status: orders.status, fulfillment: orders.fulfillment, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.conversationId, conversationId)))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
    if (!rows.length) return []
    const lines = await scope.tx
      .select({ orderId: orderLines.orderId, name: orderLines.name, quantity: orderLines.quantity, saleUnit: orderLines.saleUnit })
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scope.tenantId), inArray(orderLines.orderId, rows.map((r) => r.id))))
      .orderBy(orderLines.position)
    return rows.map(({ id, ...row }) => ({ ...row, lines: lines.filter((l) => l.orderId === id).map(({ orderId: _, ...line }) => line) }))
  }

  /** What the person may see: orders of the conversations visible to them, newest first. */
  async list(scope: MemberScope, filters: OrderFilters): Promise<OrderView[]> {
    const soldOn = filters.soldOn
      ? and(
          inArray(orders.status, [...SOLD]),
          sql`${orders.confirmedAt} >= (${filters.soldOn.date}::date::timestamp at time zone ${filters.soldOn.timezone})`,
          sql`${orders.confirmedAt} < ((${filters.soldOn.date}::date + 1)::timestamp at time zone ${filters.soldOn.timezone})`,
        )
      : undefined
    const rows = await scope.tx
      .select({
        id: orders.id,
        code: orders.code,
        status: orders.status,
        conversationId: orders.conversationId,
        contactName: sql<string | null>`coalesce(${contacts.name}, ${contacts.displayName})`,
        customerName: orders.customerName,
        fulfillment: orders.fulfillment,
        zone: orders.zone,
        address: orders.address,
        methodId: paymentMethods.id,
        methodName: paymentMethods.name,
        methodType: paymentMethods.type,
        notes: orders.notes,
        paymentReference: orders.paymentReference,
        receivedAmount: orders.receivedAmount,
        confirmedAt: orders.confirmedAt,
        confirmedBy: users.name,
        subtotalCents: orders.subtotalCents,
        deliveryCents: orders.deliveryCents,
        bsPerUsd: orders.bsPerUsd,
        receiptCount: sql<number>`(select count(*)::int from ${orderReceipts} where ${orderReceipts.tenantId} = ${orders.tenantId} and ${orderReceipts.orderId} = ${orders.id})`,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(conversations, and(eq(conversations.tenantId, orders.tenantId), eq(conversations.id, orders.conversationId)))
      .innerJoin(contacts, and(eq(contacts.tenantId, conversations.tenantId), eq(contacts.id, conversations.contactId)))
      .leftJoin(paymentMethods, and(eq(paymentMethods.tenantId, orders.tenantId), eq(paymentMethods.id, orders.paymentMethodId)))
      .leftJoin(users, eq(users.id, orders.confirmedBy))
      .where(
        and(
          eq(orders.tenantId, scope.tenantId),
          visibleConversations(scope.member),
          filters.status ? eq(orders.status, filters.status) : undefined,
          filters.conversationId ? eq(orders.conversationId, filters.conversationId) : undefined,
          filters.orderId ? eq(orders.id, filters.orderId) : undefined,
          soldOn,
        ),
      )
      .orderBy(desc(orders.createdAt))
      // A day's close needs every order of the day; the lists show the latest ones.
      .limit(filters.soldOn ? 2000 : 200)
    if (!rows.length) return []
    const lines = await scope.tx
      .select({ orderId: orderLines.orderId, name: orderLines.name, quantity: orderLines.quantity, saleUnit: orderLines.saleUnit, unitPriceCents: orderLines.unitPriceCents })
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scope.tenantId), inArray(orderLines.orderId, rows.map((r) => r.id))))
      .orderBy(orderLines.position)
    return rows.map(({ methodId, methodName, methodType, ...row }) => ({
      ...row,
      paymentMethod: methodId && methodName && methodType ? { id: methodId, name: methodName, type: methodType, currency: currencyOf(methodType) } : null,
      lines: lines.filter((l) => l.orderId === row.id).map(({ orderId: _, ...line }) => line),
    }))
  }

  async detail(scope: MemberScope, orderId: string): Promise<OrderDetail> {
    const [order] = await this.list(scope, { orderId })
    if (!order) throw new OrderNotFoundError()
    const receipts = await scope.tx
      .select({ mediaId: mediaFiles.id, mimeType: mediaFiles.mimeType, sizeBytes: mediaFiles.sizeBytes, createdAt: orderReceipts.createdAt })
      .from(orderReceipts)
      .innerJoin(mediaFiles, and(eq(mediaFiles.tenantId, orderReceipts.tenantId), eq(mediaFiles.id, orderReceipts.mediaId)))
      .where(and(eq(orderReceipts.tenantId, scope.tenantId), eq(orderReceipts.orderId, orderId)))
      .orderBy(orderReceipts.createdAt)
    const [saleReceipt] = await scope.tx
      .select({ code: saleReceipts.code, createdAt: saleReceipts.createdAt })
      .from(saleReceipts)
      .where(and(eq(saleReceipts.tenantId, scope.tenantId), eq(saleReceipts.orderId, orderId)))
    const expected = expectedAmount(order, order.paymentMethod?.currency ?? 'USD')
    const alerts = await paymentAlerts(scope, { id: order.id, paymentMethodId: order.paymentMethod?.id ?? null, paymentReference: order.paymentReference }, { expected, received: order.receivedAmount })
    return { ...order, receipts, saleReceipt: saleReceipt ?? null, expectedAmount: expected, alerts }
  }

  /**
   * Whoever sees the order writes down the payment's reference (it goes on the sale receipt) and
   * what arrived. A sold order keeps a reference its method asks for, and never one that paid another.
   */
  async setPayment(scope: MemberScope, orderId: string, check: PaymentCheck): Promise<void> {
    const order = await this.lock(scope, orderId)
    const paymentReference = check.reference || null
    if (SOLD.includes(order.status)) await checkPaymentProof(scope, { ...order, paymentReference })
    await scope.tx
      .update(orders)
      .set({ paymentReference, receivedAmount: check.receivedAmount || null })
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.id, orderId)))
  }

  /**
   * The order, locked until the transaction ends (two people confirming at once: the second waits
   * and finds it confirmed). Only to someone who sees its conversation.
   */
  private async lock(scope: MemberScope, orderId: string) {
    const [order] = await scope.tx
      .select({ id: orders.id, code: orders.code, status: orders.status, paymentMethodId: orders.paymentMethodId, paymentReference: orders.paymentReference })
      .from(orders)
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.id, orderId), visibleOrder(scope)))
      .for('update')
    if (!order) throw new OrderNotFoundError()
    return order
  }

  /** A receipt's file, only to someone who sees its order. */
  async receiptFile(scope: MemberScope, orderId: string, mediaId: string): Promise<{ content: Buffer; mimeType: string }> {
    const [file] = await scope.tx
      .select({ content: mediaFiles.content, mimeType: mediaFiles.mimeType })
      .from(orderReceipts)
      .innerJoin(orders, and(eq(orders.tenantId, orderReceipts.tenantId), eq(orders.id, orderReceipts.orderId)))
      .innerJoin(mediaFiles, and(eq(mediaFiles.tenantId, orderReceipts.tenantId), eq(mediaFiles.id, orderReceipts.mediaId)))
      .where(and(eq(orderReceipts.tenantId, scope.tenantId), eq(orderReceipts.orderId, orderId), eq(orderReceipts.mediaId, mediaId), visibleOrder(scope)))
    if (!file) throw new OrderNotFoundError()
    return file
  }

  /**
   * Moves an order along; only someone who sees its conversation. Completing or cancelling the
   * last open order of the conversation gives it back to the agent: the next purchase needs nobody.
   */
  async setStatus(scope: MemberScope, orderId: string, status: OrderStatus): Promise<SaleOutcome> {
    const order = await this.lock(scope, orderId)
    const outcome = await this.moveSale(scope, order, status)
    const [updated] = await scope.tx
      .update(orders)
      .set({ status, updatedAt: sql`now()`, ...this.confirmedFields(scope, order.status, status) })
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.id, orderId)))
      .returning({ conversationId: orders.conversationId })
    if (CLOSED.includes(status) && !(await this.hasOpenOrder(scope, updated!.conversationId))) await returnToAgent(scope, updated!.conversationId)
    return outcome
  }

  /**
   * Becoming sold (confirmed or done, from a status that was not) checks the payment proof and takes
   * the products out of the inventory; leaving it (cancelled, reopened) puts them back.
   */
  private async moveSale(scope: MemberScope, order: Awaited<ReturnType<OrderService['lock']>>, to: OrderStatus): Promise<SaleOutcome> {
    const wasSold = SOLD.includes(order.status)
    const isSold = SOLD.includes(to)
    if (isSold && !wasSold) {
      await checkPaymentProof(scope, order)
      return { stockShortfalls: await takeStock(scope, order) }
    }
    if (wasSold && !isSold) await giveBackStock(scope, order)
    return { stockShortfalls: [] }
  }

  /** Who confirmed and when: written as the order becomes sold, cleared when it stops being sold. */
  private confirmedFields(scope: MemberScope, from: OrderStatus, to: OrderStatus) {
    if (SOLD.includes(to) && !SOLD.includes(from)) return { confirmedAt: sql`now()`, confirmedBy: scope.member.userId }
    if (!SOLD.includes(to) && SOLD.includes(from)) return { confirmedAt: null, confirmedBy: null }
    return {}
  }

  private async hasOpenOrder(scope: TenantScope, conversationId: string): Promise<boolean> {
    const [open] = await scope.tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.conversationId, conversationId), notInArray(orders.status, CLOSED)))
      .limit(1)
    return open !== undefined
  }

  /**
   * Confirms an order still waiting for payment or its review. Null when it was confirmed already
   * (or moved on): then nobody tells the customer twice.
   */
  async confirm(scope: MemberScope, orderId: string): Promise<({ conversationId: string; code: string; customerName: string } & SaleOutcome) | null> {
    const order = await this.lock(scope, orderId)
    if (!CONFIRMABLE.includes(order.status)) return null
    const outcome = await this.moveSale(scope, order, 'confirmed')
    const [confirmed] = await scope.tx
      .update(orders)
      .set({ status: 'confirmed', updatedAt: sql`now()`, ...this.confirmedFields(scope, order.status, 'confirmed') })
      .where(and(eq(orders.tenantId, scope.tenantId), eq(orders.id, orderId)))
      .returning({ conversationId: orders.conversationId, code: orders.code, customerName: orders.customerName })
    return { ...confirmed!, ...outcome }
  }
}

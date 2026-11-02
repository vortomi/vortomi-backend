import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { PAYMENT_FIELD_KINDS, PAYMENT_METHOD_TYPES, PAYMENT_PROOF_RULES, type PaymentMethodType, type PaymentProofRule } from '../../db/schema/enums.ts'
import { type PaymentField, paymentMethods } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import { type PaymentCurrency, currencyOf, takesNoProof } from './payment-method-types.ts'
import { hasValidFormat } from './venezuelan-formats.ts'

const MAX_FIELDS = 12

const fieldInput = z
  .object({
    kind: z.enum(PAYMENT_FIELD_KINDS).default('text'),
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(200),
    copyable: z.boolean(),
  })
  .refine((f) => hasValidFormat(f.kind, f.value), { message: 'The value does not have the format of its kind', path: ['value'] })

export const paymentMethodInput = z
  .object({
    type: z.enum(PAYMENT_METHOD_TYPES),
    name: z.string().trim().min(2).max(120),
    fields: z.array(fieldInput).max(MAX_FIELDS),
    instructions: z.string().trim().max(2000),
    referenceRule: z.enum(PAYMENT_PROOF_RULES),
    receiptRule: z.enum(PAYMENT_PROOF_RULES),
    isActive: z.boolean(),
  })
  .refine((m) => !takesNoProof(m.type) || (m.referenceRule === 'none' && m.receiptRule === 'none'), {
    message: 'Cash and agreed payments take no reference or receipt',
    path: ['receiptRule'],
  })
export type PaymentMethodInput = z.infer<typeof paymentMethodInput>

export const paymentMethodOrderInput = z.object({ ids: z.array(z.uuid()).min(1).max(50) })

export interface PaymentMethodView {
  id: string
  type: PaymentMethodType
  name: string
  currency: PaymentCurrency
  fields: PaymentField[]
  instructions: string
  referenceRule: PaymentProofRule
  receiptRule: PaymentProofRule
  isActive: boolean
  sortOrder: number
}

export class PaymentMethodNotFoundError extends Error {
  constructor() {
    super('Payment method not found')
    this.name = 'PaymentMethodNotFoundError'
  }
}

/** A new order must list every method of the company exactly once. */
export class PaymentMethodOrderError extends Error {
  constructor() {
    super('The order must list every payment method once')
    this.name = 'PaymentMethodOrderError'
  }
}

const COLUMNS = {
  id: paymentMethods.id,
  type: paymentMethods.type,
  name: paymentMethods.name,
  fields: paymentMethods.fields,
  instructions: paymentMethods.instructions,
  referenceRule: paymentMethods.referenceRule,
  receiptRule: paymentMethods.receiptRule,
  isActive: paymentMethods.isActive,
  sortOrder: paymentMethods.sortOrder,
}

const toView = (row: Omit<PaymentMethodView, 'currency'>): PaymentMethodView => ({ ...row, currency: currencyOf(row.type) })

/**
 * How a company gets paid (Ajustes → Métodos de pago). Everyone in the company reads them; admins
 * change them (routes). Hidden instead of deleted, so the orders paid with one keep showing it.
 */
export class PaymentMethodService {
  /** In the company's order; only the visible ones for what customers are offered. */
  async list(scope: TenantScope, options: { visibleOnly?: boolean } = {}): Promise<PaymentMethodView[]> {
    const rows = await scope.tx
      .select(COLUMNS)
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, scope.tenantId), options.visibleOnly ? eq(paymentMethods.isActive, true) : undefined))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name))
    return rows.map(toView)
  }

  /** New methods go last. */
  async create(scope: TenantScope, input: PaymentMethodInput): Promise<PaymentMethodView> {
    const [row] = await scope.tx
      .insert(paymentMethods)
      .values({
        tenantId: scope.tenantId,
        ...input,
        sortOrder: sql`(select coalesce(max(${paymentMethods.sortOrder}) + 1, 0) from ${paymentMethods} where ${paymentMethods.tenantId} = ${scope.tenantId})`,
      })
      .returning(COLUMNS)
    return toView(row!)
  }

  async update(scope: TenantScope, id: string, input: PaymentMethodInput): Promise<PaymentMethodView> {
    const [row] = await scope.tx
      .update(paymentMethods)
      .set({ ...input, updatedAt: sql`now()` })
      .where(and(eq(paymentMethods.tenantId, scope.tenantId), eq(paymentMethods.id, id)))
      .returning(COLUMNS)
    if (!row) throw new PaymentMethodNotFoundError()
    return toView(row)
  }

  /** The order customers see them in: every method of the company, once. */
  async reorder(scope: TenantScope, ids: string[]): Promise<PaymentMethodView[]> {
    const current = await this.list(scope)
    const known = new Set(current.map((m) => m.id))
    if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id))) throw new PaymentMethodOrderError()
    const position = sql.join(
      ids.map((id, index) => sql`when ${id}::uuid then ${index}::int`),
      sql` `,
    )
    await scope.tx
      .update(paymentMethods)
      .set({ sortOrder: sql`case ${paymentMethods.id} ${position} end`, updatedAt: sql`now()` })
      .where(eq(paymentMethods.tenantId, scope.tenantId))
    return this.list(scope)
  }
}

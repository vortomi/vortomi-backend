import { asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { platformPaymentMethods } from '../../db/schema/index.ts'
import {
  type PaymentMethodInput,
  PaymentMethodNotFoundError,
  type PaymentMethodView,
  assertCompleteOrder,
  toView,
} from '../payment-methods/payment-method-service.ts'

const COLUMNS = {
  id: platformPaymentMethods.id,
  type: platformPaymentMethods.type,
  name: platformPaymentMethods.name,
  fields: platformPaymentMethods.fields,
  instructions: platformPaymentMethods.instructions,
  referenceRule: platformPaymentMethods.referenceRule,
  receiptRule: platformPaymentMethods.receiptRule,
  isActive: platformPaymentMethods.isActive,
  sortOrder: platformPaymentMethods.sortOrder,
}

/**
 * How companies pay Vortomi (console → Suscripciones → Métodos de pago). Same input, rules and view
 * as a company's own methods (PaymentMethodService), on Vortomi's table: no company scope, reached
 * only through the console's routes. Hidden instead of deleted.
 */
export class PlatformPaymentMethodService {
  constructor(private readonly db: Database) {}

  async list(): Promise<PaymentMethodView[]> {
    const rows = await this.db.select(COLUMNS).from(platformPaymentMethods).orderBy(asc(platformPaymentMethods.sortOrder), asc(platformPaymentMethods.name))
    return rows.map(toView)
  }

  /** New methods go last. */
  async create(input: PaymentMethodInput): Promise<PaymentMethodView> {
    const [row] = await this.db
      .insert(platformPaymentMethods)
      .values({ ...input, sortOrder: sql`(select coalesce(max(${platformPaymentMethods.sortOrder}) + 1, 0) from ${platformPaymentMethods})` })
      .returning(COLUMNS)
    return toView(row!)
  }

  async update(id: string, input: PaymentMethodInput): Promise<PaymentMethodView> {
    const [row] = await this.db
      .update(platformPaymentMethods)
      .set({ ...input, updatedAt: sql`now()` })
      .where(eq(platformPaymentMethods.id, id))
      .returning(COLUMNS)
    if (!row) throw new PaymentMethodNotFoundError()
    return toView(row)
  }

  /** The order companies see them in: every method, once. */
  async reorder(ids: string[]): Promise<PaymentMethodView[]> {
    return this.db.transaction(async (tx) => {
      const current = await tx.select({ id: platformPaymentMethods.id }).from(platformPaymentMethods).for('update')
      assertCompleteOrder(ids, current)
      const position = sql.join(
        ids.map((id, index) => sql`when ${id}::uuid then ${index}::int`),
        sql` `,
      )
      await tx.update(platformPaymentMethods).set({ sortOrder: sql`case ${platformPaymentMethods.id} ${position} end`, updatedAt: sql`now()` })
      const rows = await tx.select(COLUMNS).from(platformPaymentMethods).orderBy(asc(platformPaymentMethods.sortOrder), asc(platformPaymentMethods.name))
      return rows.map(toView)
    })
  }
}

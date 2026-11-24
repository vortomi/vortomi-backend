import { desc, eq, sql } from 'drizzle-orm'
import type { Executor } from '../../db/client.ts'
import { walletMovements } from '../../db/schema/index.ts'
import type { WalletMovementKind } from '../../db/schema/subscription-ledger.ts'

/**
 * A company's balance in favour with Vortomi (documentations/18 §4 bis), in dollar cents: the sum
 * of its movements, never a number edited by hand.
 */
export async function walletBalance(executor: Executor, tenantId: string): Promise<number> {
  const [row] = await executor
    .select({ cents: sql<number>`coalesce(sum(${walletMovements.amountCents}), 0)::int` })
    .from(walletMovements)
    .where(eq(walletMovements.tenantId, tenantId))
  return row?.cents ?? 0
}

export interface WalletMovementView {
  id: string
  kind: WalletMovementKind
  amountCents: number
  paymentId: string | null
  chargeId: string | null
  createdAt: Date
}

/** Newest first. */
export function walletMovementsOf(executor: Executor, tenantId: string): Promise<WalletMovementView[]> {
  return executor
    .select({
      id: walletMovements.id,
      kind: walletMovements.kind,
      amountCents: walletMovements.amountCents,
      paymentId: walletMovements.paymentId,
      chargeId: walletMovements.chargeId,
      createdAt: walletMovements.createdAt,
    })
    .from(walletMovements)
    .where(eq(walletMovements.tenantId, tenantId))
    .orderBy(desc(walletMovements.createdAt))
}

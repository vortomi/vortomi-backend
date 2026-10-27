import { desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { RATE_SOURCES, type RateSource } from '../../db/schema/enums.ts'
import { bcvStatus, exchangeRates, tenantSettings, users } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

/** How many rates the panel lists, newest first; the first is the company's rate. */
const HISTORY_SIZE = 20

export const rateSourceInput = z.object({ rateSource: z.enum(RATE_SOURCES) })

/** "887.30" (point, up to 8 decimals) from today or any day: "Vigente desde" is a reference only. */
export const manualRateInput = z.object({
  bsPerUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .refine((value) => Number(value) > 0, 'greater than 0'),
  effectiveDate: z.iso.date(),
})
export type ManualRateInput = z.infer<typeof manualRateInput>

/** What the panel's "Tasa de cambio" card shows; every write answers with it too. */
export interface ExchangeRateView {
  rateSource: RateSource
  /** The platform's last read of the BCV; all null until the first one. */
  bcv: { bsPerUsd: string | null; effectiveDate: string | null; checkedAt: Date | null; error: string | null }
  exchangeRates: {
    bsPerUsd: string
    previousBsPerUsd: string | null
    effectiveDate: string
    /** Name of the admin who typed it; null for the BCV's and the carried-over ones. */
    changedBy: string | null
    createdAt: Date
    source: 'bcv' | 'manual'
  }[]
}

/** A company's exchange rate: where it comes from, and the rates it typed by hand. */
export class ExchangeRateService {
  async view(scope: MemberScope): Promise<ExchangeRateView> {
    const [bcv] = await scope.tx
      .select({ bsPerUsd: bcvStatus.rate, effectiveDate: bcvStatus.effectiveDate, checkedAt: bcvStatus.checkedAt, error: bcvStatus.error })
      .from(bcvStatus)
    const history = await scope.tx
      .select({
        bsPerUsd: exchangeRates.rate,
        previousBsPerUsd: exchangeRates.previousRate,
        effectiveDate: exchangeRates.effectiveDate,
        changedBy: users.name,
        createdAt: exchangeRates.createdAt,
        source: exchangeRates.source,
      })
      .from(exchangeRates)
      .leftJoin(users, eq(users.id, exchangeRates.changedBy))
      .where(eq(exchangeRates.tenantId, scope.tenantId))
      .orderBy(desc(exchangeRates.createdAt))
      .limit(HISTORY_SIZE)
    return {
      rateSource: await this.rateSource(scope),
      bcv: bcv ?? { bsPerUsd: null, effectiveDate: null, checkedAt: null, error: null },
      exchangeRates: history,
    }
  }

  async rateSource(scope: MemberScope): Promise<RateSource> {
    const [row] = await scope.tx.select({ rateSource: tenantSettings.rateSource }).from(tenantSettings).where(eq(tenantSettings.tenantId, scope.tenantId))
    return row?.rateSource ?? 'custom'
  }

  /** Only the source: the company's other settings stay as they are (or at their defaults). */
  async setSource(scope: MemberScope, rateSource: RateSource): Promise<void> {
    await scope.tx
      .insert(tenantSettings)
      .values({ tenantId: scope.tenantId, rateSource })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { rateSource, updatedAt: sql`now()` } })
  }

  /** A rate typed by an admin; it is the company's rate from now on, whatever its "Vigente desde". */
  async addManual(scope: MemberScope, input: ManualRateInput): Promise<void> {
    await scope.tx.insert(exchangeRates).values({
      tenantId: scope.tenantId,
      rate: input.bsPerUsd,
      effectiveDate: input.effectiveDate,
      previousRate: sql`(select er.rate from exchange_rates er where er.tenant_id = ${scope.tenantId}::uuid order by er.created_at desc limit 1)`,
      source: 'manual',
      changedBy: scope.member.userId,
    })
  }
}

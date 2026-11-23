import { desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { RateSource } from '../../db/schema/enums.ts'
import { bcvStatus, platformExchangeRates, platformSettings, users } from '../../db/schema/index.ts'
import type { ExchangeRateView, ManualRateInput } from '../exchange-rates/exchange-rate-service.ts'

/** How many rates the console lists, newest first; the first is Vortomi's rate. */
const HISTORY_SIZE = 20

/**
 * Vortomi's own exchange rate (console → Ajustes → Tasa de cambio, mockup web-36): the same card,
 * input and rules as a company's (ExchangeRateService), on Vortomi's tables. The BCV's rates arrive
 * through the platform's single BCV reader (BcvRateService). Reached only through the console.
 */
export class PlatformExchangeRateService {
  constructor(private readonly db: Database) {}

  async view(): Promise<ExchangeRateView> {
    const [bcv] = await this.db
      .select({ bsPerUsd: bcvStatus.rate, effectiveDate: bcvStatus.effectiveDate, checkedAt: bcvStatus.checkedAt, error: bcvStatus.error })
      .from(bcvStatus)
    const history = await this.db
      .select({
        bsPerUsd: platformExchangeRates.rate,
        previousBsPerUsd: platformExchangeRates.previousRate,
        effectiveDate: platformExchangeRates.effectiveDate,
        changedBy: users.name,
        createdAt: platformExchangeRates.createdAt,
        source: platformExchangeRates.source,
      })
      .from(platformExchangeRates)
      .leftJoin(users, eq(users.id, platformExchangeRates.changedBy))
      .orderBy(desc(platformExchangeRates.createdAt))
      .limit(HISTORY_SIZE)
    return {
      rateSource: await this.rateSource(),
      bcv: bcv ?? { bsPerUsd: null, effectiveDate: null, checkedAt: null, error: null },
      exchangeRates: history,
      system: null,
    }
  }

  /** «Tasa personalizada» until the console chooses otherwise. */
  async rateSource(): Promise<RateSource> {
    const [row] = await this.db.select({ rateSource: platformSettings.rateSource }).from(platformSettings)
    return row?.rateSource ?? 'custom'
  }

  async setSource(rateSource: RateSource): Promise<void> {
    await this.db
      .insert(platformSettings)
      .values({ id: true, rateSource })
      .onConflictDoUpdate({ target: platformSettings.id, set: { rateSource, updatedAt: sql`now()` } })
  }

  /** A rate typed by a staff member; it is Vortomi's rate from now on, whatever its "Vigente desde". */
  async addManual(input: ManualRateInput, userId: string): Promise<void> {
    await this.db.insert(platformExchangeRates).values({
      rate: input.bsPerUsd,
      effectiveDate: input.effectiveDate,
      previousRate: sql`(select r.rate from platform_exchange_rates r order by r.created_at desc limit 1)`,
      source: 'manual',
      changedBy: userId,
    })
  }
}

import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { bcvStatus, tenantSettings } from '../../db/schema/index.ts'
import type { BcvRate } from './bcv-page.ts'
import { BCV_NO_ANSWER, BcvReadError, type BcvSource } from './bcv-source.ts'

/** First read after the server starts, so a deploy does not wait an hour. */
const FIRST_READ_DELAY_MS = 30_000
/** Admins of many companies may press "Actualizar ahora": the BCV is read at most this often. */
const MIN_READ_GAP_MS = 60_000

/**
 * The BCV rate for every company that chose it (ochoa-parts doc 18, B-104, made multi-company):
 * read every hour, on "Actualizar ahora" and on switching to it, but only while at least one
 * company uses it. The read is kept once for the platform (bcv_status); each company that uses
 * the BCV gets it in its own history from its fecha valor, on its own calendar, never before.
 * A failed read keeps the last good one: no company goes without a rate.
 */
export class BcvRateService {
  private running: Promise<void> | null = null
  private lastReadAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly db: Database,
    private readonly source: BcvSource,
    private readonly log: { error(details: object, message: string): void },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reads on a timer; `everyMs` 0 turns it off (tests). Returns the stop function. */
  start(everyMs: number): () => Promise<void> {
    if (everyMs <= 0) return () => Promise.resolve()
    const first = setTimeout(() => void this.refresh(), FIRST_READ_DELAY_MS)
    const repeat = setInterval(() => void this.refresh(), everyMs)
    first.unref()
    repeat.unref()
    return async () => {
      clearTimeout(first)
      clearInterval(repeat)
      await this.running
    }
  }

  /** Reads the BCV now (if not read a moment ago) and applies it; calls at once share one. Never throws. */
  refresh(): Promise<void> {
    this.running ??= this.readAndApply()
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'BCV rate refresh failed')
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async readAndApply(): Promise<void> {
    const [anyone] = await this.db.select({ id: tenantSettings.tenantId }).from(tenantSettings).where(eq(tenantSettings.rateSource, 'bcv')).limit(1)
    if (!anyone) return

    let read: { rate: BcvRate | null; error: string | null } | null = null
    if (this.now() - this.lastReadAt >= MIN_READ_GAP_MS) {
      this.lastReadAt = this.now()
      try {
        read = { rate: await this.source.read(), error: null }
      } catch (failure) {
        read = { rate: null, error: failure instanceof BcvReadError ? failure.message : BCV_NO_ANSWER }
      }
    }

    // As the platform, not as a company: it writes into every company that chose the BCV.
    await this.db.transaction(async (tx) => {
      // One writer at a time, even with several server instances.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bcv-rate'))`)
      if (read?.rate) {
        const values = { rate: read.rate.bsPerUsd, effectiveDate: read.rate.effectiveDate, checkedAt: sql`now()`, error: null }
        await tx.insert(bcvStatus).values({ id: true, ...values }).onConflictDoUpdate({ target: bcvStatus.id, set: values })
      } else if (read) {
        // A failed read keeps the last good one on screen, with the reason.
        await tx
          .insert(bcvStatus)
          .values({ id: true, checkedAt: sql`now()`, error: read.error })
          .onConflictDoUpdate({ target: bcvStatus.id, set: { checkedAt: sql`now()`, error: read.error } })
      }
      // From its fecha valor on each company's calendar (the BCV publishes the day before), when
      // it differs from the company's rate or the company still shows one typed by hand.
      await tx.execute(sql`
        insert into exchange_rates (tenant_id, rate, effective_date, previous_rate, source)
        select s.tenant_id, b.rate, b.effective_date, latest.rate, 'bcv'
          from bcv_status b
          join tenant_settings s on s.rate_source = 'bcv'
          join tenants t on t.id = s.tenant_id
          left join lateral (select er.rate, er.source from exchange_rates er
                              where er.tenant_id = s.tenant_id
                              order by er.created_at desc limit 1) as latest on true
         where b.rate is not null
           and b.effective_date <= (now() at time zone t.timezone)::date
           and (latest.rate is null or latest.rate <> b.rate or latest.source <> 'bcv')
      `)
    })
  }
}

import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { WORK_MODES } from '../../db/schema/enums.ts'
import { tenantSettings } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const businessDay = z
  .object({ day: z.literal([0, 1, 2, 3, 4, 5, 6]), open: z.string().regex(TIME).nullable(), close: z.string().regex(TIME).nullable() })
  .refine((d) => (d.open === null) === (d.close === null), 'open and close go together')
  .refine((d) => d.open === null || d.close === null || d.open < d.close, 'closes after it opens')

export const settingsInput = z.object({
  workMode: z.enum(WORK_MODES),
  businessHours: z
    .array(businessDay)
    .max(7)
    .refine((days) => new Set(days.map((d) => d.day)).size === days.length, 'one entry per day'),
  awayMessage: z.string().trim().max(1024),
  exchangeRateVes: z.number().positive().max(1e9).nullable(),
})
export type SettingsInput = z.infer<typeof settingsInput>

/** What a company that never saved its settings works with. */
const DEFAULTS: SettingsInput = { workMode: 'sales_and_support', businessHours: [], awayMessage: '', exchangeRateVes: null }

export class SettingsService {
  async get(scope: MemberScope): Promise<SettingsInput> {
    const [row] = await scope.tx
      .select({
        workMode: tenantSettings.workMode,
        businessHours: tenantSettings.businessHours,
        awayMessage: tenantSettings.awayMessage,
        exchangeRateVes: tenantSettings.exchangeRateVes,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, scope.tenantId))
    return row ?? DEFAULTS
  }

  async save(scope: MemberScope, input: SettingsInput): Promise<SettingsInput> {
    await scope.tx
      .insert(tenantSettings)
      .values({ tenantId: scope.tenantId, ...input })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...input, updatedAt: sql`now()` } })
    return this.get(scope)
  }
}

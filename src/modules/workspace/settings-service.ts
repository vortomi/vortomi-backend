import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { WORK_MODES } from '../../db/schema/enums.ts'
import { tenantSettings, tenants } from '../../db/schema/index.ts'
import { timeZone } from '../../shared/time-zone.ts'
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
})
export type SettingsInput = z.infer<typeof settingsInput>

/** What a company's admins may change of the company itself; the rest stays with our console. */
export const profileInput = z.object({ name: z.string().trim().min(1).max(80), timezone: timeZone })
export type ProfileInput = z.infer<typeof profileInput>

/** What a company that never saved its settings works with. */
const DEFAULTS: SettingsInput = { workMode: 'sales_and_support', businessHours: [], awayMessage: '' }

export class SettingsService {
  async get(scope: MemberScope): Promise<SettingsInput> {
    const [row] = await scope.tx
      .select({
        workMode: tenantSettings.workMode,
        businessHours: tenantSettings.businessHours,
        awayMessage: tenantSettings.awayMessage,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, scope.tenantId))
    return row ?? DEFAULTS
  }

  async saveProfile(scope: MemberScope, input: ProfileInput): Promise<ProfileInput> {
    const [row] = await scope.tx
      .update(tenants)
      .set(input)
      .where(eq(tenants.id, scope.tenantId))
      .returning({ name: tenants.name, timezone: tenants.timezone })
    return row!
  }

  async save(scope: MemberScope, input: SettingsInput): Promise<SettingsInput> {
    await scope.tx
      .insert(tenantSettings)
      .values({ tenantId: scope.tenantId, ...input })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...input, updatedAt: sql`now()` } })
    return this.get(scope)
  }
}

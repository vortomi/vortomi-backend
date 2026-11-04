import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DELIVERY_CHARGES, DELIVERY_MODES, type DeliveryCharge, type DeliveryMode } from '../../db/schema/enums.ts'
import { type DeliveryZone, deliverySettings } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'

const cents = z.number().int().min(0).max(100_000_000)

export const deliveryInput = z.object({
  enabled: z.boolean(),
  mode: z.enum(DELIVERY_MODES),
  flatPriceCents: cents,
  // Older panels do not send it: one charge per order, as before.
  charge: z.enum(DELIVERY_CHARGES).default('per_order'),
  zones: z
    .array(z.object({ name: z.string().trim().min(1).max(40), priceCents: cents }))
    .max(100)
    .refine((zones) => new Set(zones.map((z) => z.name.toLowerCase())).size === zones.length, 'Zone names must be unique'),
})
export type DeliveryInput = z.infer<typeof deliveryInput>

/** «Ajustes → Delivery», and what the sales agent tells customers about delivery. */
export interface DeliveryView {
  /** False until the company saves it once: then nobody has said whether it delivers. */
  configured: boolean
  enabled: boolean
  mode: DeliveryMode
  flatPriceCents: number
  charge: DeliveryCharge
  zones: DeliveryZone[]
}

const DEFAULTS = { enabled: false, mode: 'zones', flatPriceCents: 0, charge: 'per_order', zones: [] } as const

/** How a company delivers: one price everywhere or a price per zone, per order or per piece. Writes are admins only (routes). */
export class DeliveryService {
  async view(scope: TenantScope): Promise<DeliveryView> {
    const [row] = await scope.tx
      .select({ enabled: deliverySettings.enabled, mode: deliverySettings.mode, flatPriceCents: deliverySettings.flatPriceCents, charge: deliverySettings.charge, zones: deliverySettings.zones })
      .from(deliverySettings)
      .where(eq(deliverySettings.tenantId, scope.tenantId))
    return row ? { configured: true, ...row } : { configured: false, ...DEFAULTS, zones: [] }
  }

  async save(scope: TenantScope, input: DeliveryInput): Promise<DeliveryView> {
    await scope.tx
      .insert(deliverySettings)
      .values({ tenantId: scope.tenantId, ...input })
      .onConflictDoUpdate({ target: deliverySettings.tenantId, set: { ...input, updatedAt: sql`now()` } })
    return this.view(scope)
  }
}

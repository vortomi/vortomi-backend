import type { Database } from '../../src/db/client.ts'
import { channelAccounts, tenants } from '../../src/db/schema/index.ts'
import { PHONE_A, PHONE_B } from './meta-payloads.ts'

export interface SeededTenant {
  tenantId: string
  channelAccountId: string
  phoneNumberId: string
  /** Each company has its own WhatsApp Business Account (one company per WABA). */
  wabaId: string
}

/** Creates a company with one number, the way the platform does (server role). */
export async function seedTenant(db: Database, name: string, phoneNumberId: string): Promise<SeededTenant> {
  const wabaId = `2${phoneNumberId.slice(1)}`
  const [tenant] = await db
    .insert(tenants)
    .values({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      status: 'active',
      plan: 'team',
      legalName: `${name}, C.A.`,
      taxId: 'J-41234567-8',
      fiscalAddress: 'Caracas',
    })
    .returning({ id: tenants.id })
  const [channel] = await db
    .insert(channelAccounts)
    .values({ tenantId: tenant!.id, wabaId, phoneNumberId, displayNumber: '+58 412-555-0101', label: 'Ventas' })
    .returning({ id: channelAccounts.id })
  return { tenantId: tenant!.id, channelAccountId: channel!.id, phoneNumberId, wabaId }
}

/** The two companies every isolation test plays with. */
export async function seedTwoTenants(db: Database): Promise<{ a: SeededTenant; b: SeededTenant }> {
  return { a: await seedTenant(db, 'Empresa A', PHONE_A), b: await seedTenant(db, 'Empresa B', PHONE_B) }
}

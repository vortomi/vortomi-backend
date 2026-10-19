// Registers a company and its WhatsApp number, the manual way (phases 0 and 1).
// Phase 0: our own company and the number we already have configured in Meta.
//
//   npm run channel:register -- --name "Nosotros" --legal-name "Vortex Autonomy, C.A." \
//     --tax-id J-50000000-1 --fiscal-address "Caracas" --plan internal \
//     --phone-number-id 123456789012345 --waba-id 987654321098765 \
//     --display-number "+58 412-555-0100" --label "Soporte"
//
// Runs with the server's own connection (DATABASE_URL in .env). The UNIQUE on
// phone_number_id rejects a number that already belongs to another company.
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { createDatabase } from '../src/db/client.ts'
import { TENANT_PLANS } from '../src/db/schema/enums.ts'
import { channelAccounts, tenants } from '../src/db/schema/index.ts'

const argsSchema = z.object({
  name: z.string().trim().min(2),
  'legal-name': z.string().trim().min(2),
  'tax-id': z.string().regex(/^[JVEGPC]-\d{8}-\d$/, 'Use the shape J-41234567-8'),
  'fiscal-address': z.string().trim().min(2).max(256),
  plan: z.enum(TENANT_PLANS),
  timezone: z.string().default('America/Caracas'),
  'phone-number-id': z.string().regex(/^\d+$/),
  'waba-id': z.string().regex(/^\d+$/),
  'display-number': z.string().trim().min(5),
  label: z.string().trim().min(1),
})

const slugify = (text: string) =>
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is missing in .env')

  const { values } = parseArgs({
    options: Object.fromEntries(Object.keys(argsSchema.shape).map((key) => [key, { type: 'string' }])),
    strict: true,
  })
  const parsed = argsSchema.safeParse(values)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  const args = parsed.data

  const database = createDatabase(url, 1)
  try {
    const result = await database.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: args.name,
          slug: slugify(args.name),
          status: 'active',
          plan: args.plan,
          timezone: args.timezone,
          legalName: args['legal-name'],
          taxId: args['tax-id'],
          fiscalAddress: args['fiscal-address'],
        })
        .returning({ id: tenants.id })
      if (!tenant) throw new Error('Tenant insert returned no row')
      const [channel] = await tx
        .insert(channelAccounts)
        .values({
          tenantId: tenant.id,
          wabaId: args['waba-id'],
          phoneNumberId: args['phone-number-id'],
          displayNumber: args['display-number'],
          label: args.label,
        })
        .returning({ id: channelAccounts.id })
      if (!channel) throw new Error('Channel insert returned no row')
      return { tenantId: tenant.id, channelAccountId: channel.id }
    })
    // eslint-disable-next-line no-console
    console.log(`Registered: tenant ${result.tenantId}, number ${result.channelAccountId}`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

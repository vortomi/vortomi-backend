// Links a person who already exists in Supabase Auth to a company (phase 0 and support).
// The normal path will be the invitation link; this is for our own team and fixes.
//
//   npm run member:add -- --tenant-slug nosotros --user-id <supabase user uuid> \
//     --email yo@empresa.com --name "Nombre Apellido" --role admin [--platform-role super_admin]
//
// The person gets every number of the company. Runs with the server's own connection.
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDatabase } from '../src/db/client.ts'
import { MEMBER_ROLES, PLATFORM_ROLES } from '../src/db/schema/enums.ts'
import { channelAccounts, membershipChannels, memberships, tenants, users } from '../src/db/schema/index.ts'

const argsSchema = z.object({
  'tenant-slug': z.string().trim().min(1),
  'user-id': z.uuid(),
  email: z.email().transform((email) => email.toLowerCase()),
  name: z.string().trim().min(2),
  role: z.enum(MEMBER_ROLES),
  'platform-role': z.enum(PLATFORM_ROLES).optional(),
})

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
    await database.db.transaction(async (tx) => {
      const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, args['tenant-slug']))
      if (!tenant) throw new Error(`No company with slug "${args['tenant-slug']}"`)

      await tx
        .insert(users)
        .values({ id: args['user-id'], email: args.email, name: args.name, platformRole: args['platform-role'] ?? null })
        .onConflictDoUpdate({ target: users.id, set: { name: args.name, platformRole: args['platform-role'] ?? null } })
      await tx.insert(memberships).values({
        tenantId: tenant.id,
        userId: args['user-id'],
        role: args.role,
        status: 'active',
        canSeeOthers: true,
      })
      const channels = await tx.select({ id: channelAccounts.id }).from(channelAccounts).where(eq(channelAccounts.tenantId, tenant.id))
      if (channels.length) {
        await tx
          .insert(membershipChannels)
          .values(channels.map((channel) => ({ tenantId: tenant.id, userId: args['user-id'], channelAccountId: channel.id })))
      }
    })
    // eslint-disable-next-line no-console
    console.log(`Added ${args.email} to ${args['tenant-slug']} as ${args.role}`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

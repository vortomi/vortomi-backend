// Stores (or replaces) the access token a number sends with, encrypted.
//
//   npm run channel:set-token -- --phone-number-id 123456789012345
//
// The token is read from standard input, never from the command line, so it does not
// end up in the shell history or the process list. Paste it and press Enter.
// Needs DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY in .env.
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDatabase } from '../src/db/client.ts'
import { channelAccounts } from '../src/db/schema/index.ts'
import { ChannelCredentials } from '../src/modules/channels/channel-credentials.ts'
import { CredentialCipher } from '../src/modules/channels/credential-cipher.ts'

async function readToken(): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false })
  try {
    for await (const line of lines) if (line.trim()) return line.trim()
  } finally {
    lines.close()
  }
  throw new Error('No token received on standard input')
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const url = process.env.DATABASE_URL
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!url || !key) throw new Error('DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY are required in .env')

  const { values } = parseArgs({ options: { 'phone-number-id': { type: 'string' } }, strict: true })
  const phoneNumberId = z.string().regex(/^\d+$/).parse(values['phone-number-id'])

  const database = createDatabase(url, 1)
  try {
    const [channel] = await database.db
      .select({ id: channelAccounts.id, tenantId: channelAccounts.tenantId })
      .from(channelAccounts)
      .where(eq(channelAccounts.phoneNumberId, phoneNumberId))
    if (!channel) throw new Error(`No number registered with phone_number_id ${phoneNumberId}`)

    // eslint-disable-next-line no-console
    console.log('Paste the access token and press Enter:')
    const token = await readToken()
    await new ChannelCredentials(database.db, new CredentialCipher(key)).store(channel.tenantId, channel.id, token)
    // eslint-disable-next-line no-console
    console.log(`Token stored, encrypted, for number ${phoneNumberId}`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

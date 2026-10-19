import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { channelAccounts, channelCredentials } from '../../db/schema/index.ts'
import type { CredentialCipher } from './credential-cipher.ts'

/**
 * Platform-side store of each number's access token. Server role only (the table
 * is not granted to tenant_scoped). The token is decrypted just for the call to
 * Meta and never logged, returned by the API or kept in memory.
 */
export class ChannelCredentials {
  constructor(
    private readonly db: Database,
    private readonly cipher: CredentialCipher,
  ) {}

  /** Binds the ciphertext to its company and number. */
  private static context(tenantId: string, channelAccountId: string): string {
    return `channel-credential:${tenantId}:${channelAccountId}`
  }

  async store(tenantId: string, channelAccountId: string, accessToken: string): Promise<void> {
    const encryptedAccessToken = this.cipher.encrypt(accessToken, ChannelCredentials.context(tenantId, channelAccountId))
    await this.db
      .insert(channelCredentials)
      .values({ tenantId, channelAccountId, encryptedAccessToken })
      .onConflictDoUpdate({ target: channelCredentials.channelAccountId, set: { encryptedAccessToken, updatedAt: sql`now()` } })
  }

  /** Token of any number of that WhatsApp Business Account in this company (managing templates). */
  async accessTokenForWaba(tenantId: string, wabaId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ channelAccountId: channelCredentials.channelAccountId })
      .from(channelCredentials)
      .innerJoin(channelAccounts, and(eq(channelAccounts.tenantId, channelCredentials.tenantId), eq(channelAccounts.id, channelCredentials.channelAccountId)))
      .where(and(eq(channelCredentials.tenantId, tenantId), eq(channelAccounts.wabaId, wabaId)))
      .limit(1)
    return row ? this.accessTokenFor(tenantId, row.channelAccountId) : null
  }

  async accessTokenFor(tenantId: string, channelAccountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ encryptedAccessToken: channelCredentials.encryptedAccessToken })
      .from(channelCredentials)
      .where(and(eq(channelCredentials.tenantId, tenantId), eq(channelCredentials.channelAccountId, channelAccountId)))
    return row ? this.cipher.decrypt(row.encryptedAccessToken, ChannelCredentials.context(tenantId, channelAccountId)) : null
  }
}

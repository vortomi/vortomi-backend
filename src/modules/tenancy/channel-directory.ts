import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import { channelAccounts } from '../../db/schema/index.ts'

/** Where an event belongs: the company and the number it arrived on. */
export interface ChannelRoute {
  tenantId: string
  channelAccountId: string
}

/**
 * Routing of Meta events to companies (design document 8.1): the phone_number_id in
 * each event is the ONLY thing that says whose it is. Platform-level lookup, so it
 * runs as the server role; the UNIQUE on phone_number_id guarantees one answer.
 * An unknown number returns null and the event is set aside, never guessed.
 */
export class ChannelDirectory {
  constructor(private readonly db: Database) {}

  /**
   * Company that owns a WhatsApp Business Account (template webhooks carry no number).
   * A trigger keeps a WABA in one company; if that were ever broken, the answer is
   * null rather than a guess.
   */
  async resolveWaba(wabaId: string): Promise<string | null> {
    const rows = await this.db
      .selectDistinct({ tenantId: channelAccounts.tenantId })
      .from(channelAccounts)
      .where(eq(channelAccounts.wabaId, wabaId))
      .limit(2)
    return rows.length === 1 ? rows[0]!.tenantId : null
  }

  async resolve(phoneNumberId: string): Promise<ChannelRoute | null> {
    const [row] = await this.db
      .select({ tenantId: channelAccounts.tenantId, channelAccountId: channelAccounts.id })
      .from(channelAccounts)
      .where(eq(channelAccounts.phoneNumberId, phoneNumberId))
      .limit(1)
    return row ?? null
  }
}

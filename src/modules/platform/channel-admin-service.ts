import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { channelAccounts } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import { ChannelNotFoundError } from '../team/channel-list.ts'
import { type WabaDirectory, WhatsAppApiError } from '../whatsapp/cloud-api.client.ts'
import { type TenantAdminService, WabaTakenError } from './tenant-admin-service.ts'

/** The chosen number is not in that WhatsApp Business Account (Meta says which ones are). */
export class NumberNotInAccountError extends Error {
  constructor() {
    super('That number is not in the WhatsApp Business Account')
    this.name = 'NumberNotInAccountError'
  }
}

/** Another company of the platform already has that number. */
export class NumberTakenError extends Error {
  constructor() {
    super('That number belongs to another company')
    this.name = 'NumberTakenError'
  }
}

/** Meta refused the call: a wrong or expired token, or an account the token cannot see. */
export class MetaRefusedError extends Error {
  constructor() {
    super('Meta refused the request for that account')
    this.name = 'MetaRefusedError'
  }
}

/** Meta's own refusals become a clear answer; anything else stays an error of ours. */
async function fromMeta<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (error) {
    if (error instanceof WhatsAppApiError) throw new MetaRefusedError()
    throw error
  }
}

/** No access token was given and none is stored for the number. */
export class TokenRequiredError extends Error {
  constructor() {
    super('An access token is needed for that account')
    this.name = 'TokenRequiredError'
  }
}

const digits = z.string().trim().regex(/^\d{5,25}$/)
const optionalToken = z
  .string()
  .trim()
  .max(1024)
  .optional()
  .transform((t) => (t ? t : undefined))
  .refine((t) => t === undefined || t.length >= 20, 'Access token too short')

/** Looking up the numbers of an account for an existing number: the stored token serves when none is typed. */
export const channelLookupInput = z.object({ wabaId: digits, accessToken: optionalToken })
export const replaceNumberInput = channelLookupInput.extend({ phoneNumberId: digits })
export type ReplaceNumberInput = z.infer<typeof replaceNumberInput>

/**
 * A company's connected numbers, from the console: correct a number connected by mistake (or move
 * to the company's real one) and refresh what is shown from Meta. The number keeps its place in
 * Vortomi (same row), so its conversations, contacts and orders stay with the company; from then on
 * Meta's events for the new number reach it and the old one no longer does.
 */
export class ChannelAdminService {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly waba: WabaDirectory,
    private readonly tenants: Pick<TenantAdminService, 'lookupNumbers'>,
  ) {}

  /** The account's numbers, marking the ones of other companies; with the number's stored token if none is given. */
  async lookup(tenantId: string, channelId: string, wabaId: string, accessToken?: string) {
    const channel = await this.channel(tenantId, channelId)
    return fromMeta(this.tenants.lookupNumbers(tenantId, wabaId, await this.token(tenantId, channel.id, accessToken)))
  }

  /**
   * Points the number at another one of Meta: checked against the account (it must be there and be
   * no other company's), its shown number taken from Meta, the token kept encrypted, the app subscribed.
   */
  async replace(tenantId: string, channelId: string, input: ReplaceNumberInput) {
    const channel = await this.channel(tenantId, channelId)
    const token = await this.token(tenantId, channel.id, input.accessToken)
    const found = await fromMeta(this.tenants.lookupNumbers(tenantId, input.wabaId, token))
    if (found.wabaTakenBy) throw new WabaTakenError()
    const number = found.numbers.find((n) => n.phoneNumberId === input.phoneNumberId)
    if (!number) throw new NumberNotInAccountError()
    if (number.takenBy) throw new NumberTakenError()
    const same = await this.db
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.phoneNumberId, input.phoneNumberId), eq(channelAccounts.tenantId, tenantId)))
    if (same.some((row) => row.id !== channel.id)) throw new NumberTakenError()

    const [updated] = await this.db
      .update(channelAccounts)
      .set({ wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayNumber: number.displayNumber, status: 'connected' })
      .where(eq(channelAccounts.id, channel.id))
      .returning({ id: channelAccounts.id, displayNumber: channelAccounts.displayNumber })
    if (input.accessToken) await this.credentials.store(tenantId, channel.id, input.accessToken)
    // Without the subscription nothing arrives; the change is kept and the console says so.
    const subscribed = await this.waba.subscribeApp(input.wabaId, token).then(
      () => true,
      () => false,
    )
    return { id: updated!.id, displayNumber: updated!.displayNumber, subscribed }
  }

  /** Writes again the number as Meta shows it (a number typed by hand may be wrong). */
  async refresh(tenantId: string, channelId: string) {
    const channel = await this.channel(tenantId, channelId)
    const token = await this.token(tenantId, channel.id)
    const number = (await fromMeta(this.waba.listNumbers(channel.wabaId, token))).find((n) => n.phoneNumberId === channel.phoneNumberId)
    if (!number) throw new NumberNotInAccountError()
    await this.db.update(channelAccounts).set({ displayNumber: number.displayNumber }).where(eq(channelAccounts.id, channel.id))
    return { displayNumber: number.displayNumber }
  }

  private async channel(tenantId: string, channelId: string) {
    const [row] = await this.db
      .select({ id: channelAccounts.id, wabaId: channelAccounts.wabaId, phoneNumberId: channelAccounts.phoneNumberId })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, channelId), eq(channelAccounts.tenantId, tenantId)))
    if (!row) throw new ChannelNotFoundError()
    return row
  }

  private async token(tenantId: string, channelId: string, given?: string): Promise<string> {
    if (given) return given
    const stored = await this.credentials.accessTokenFor(tenantId, channelId)
    if (!stored) throw new TokenRequiredError()
    return stored
  }
}

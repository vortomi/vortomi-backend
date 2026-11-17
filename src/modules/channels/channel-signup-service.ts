import { randomInt } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { channelAccounts } from '../../db/schema/index.ts'
import { NumberNotInAccountError, NumberTakenError, fromMeta } from '../platform/channel-admin-service.ts'
import { type TenantAdminService, WabaTakenError } from '../platform/tenant-admin-service.ts'
import { type AppDataSync, type WabaDirectory, WhatsAppApiError } from '../whatsapp/cloud-api.client.ts'
import type { BusinessTokenExchange } from '../whatsapp/meta-oauth.client.ts'
import type { ChannelCredentials } from './channel-credentials.ts'

/** «Conectar WhatsApp» is not set up on this server (no Embedded Signup app). */
export class SignupUnavailableError extends Error {
  constructor() {
    super('Embedded Signup is not configured')
    this.name = 'SignupUnavailableError'
  }
}

/** Meta did not take the code: expired (it lives 30 seconds), already used or not ours. */
export class SignupCodeRejectedError extends Error {
  constructor() {
    super('Meta did not accept the signup code')
    this.name = 'SignupCodeRejectedError'
  }
}

/** The token is not for our app, or the company did not grant it the account it named. */
export class SignupGrantMismatchError extends Error {
  constructor() {
    super('The token does not grant that WhatsApp Business Account to this app')
    this.name = 'SignupGrantMismatchError'
  }
}

const digits = z.string().trim().regex(/^\d{5,25}$/)

/** What the panel got from Meta's window: the code (from the login) and the account and number chosen. */
export const signupInput = z.object({
  code: z.string().trim().min(10).max(2048).regex(/^\S+$/),
  wabaId: digits,
  phoneNumberId: digits,
})
export type SignupInput = z.infer<typeof signupInput>

export interface SignupResult {
  channelId: string
  displayNumber: string
  coexistence: boolean
  /** Our app receives the account's events; false: nothing would arrive (retry by connecting again). */
  subscribed: boolean
  tokenExpiresAt: Date | null
  /** Contacts and chat history asked to the owner's app (coexistence only; once, within 24 h). */
  syncRequested: AppDataSync[]
}

interface Log {
  warn(obj: object, message: string): void
}

/**
 * A company connects its own WhatsApp number from the panel (Meta's Embedded Signup). The code is
 * exchanged here, never in the browser; the token is checked to be ours and to grant the account
 * named, the number must be in that account and no other company's. A number already on the
 * WhatsApp Business app (coexistence) is already registered; a new one is registered with a PIN
 * we keep encrypted. Connecting the same number again renews its token instead of adding it twice.
 */
export class ChannelSignupService {
  constructor(
    private readonly db: Database,
    private readonly credentials: ChannelCredentials,
    private readonly waba: WabaDirectory,
    private readonly tenants: Pick<TenantAdminService, 'lookupNumbers'>,
    private readonly exchange: BusinessTokenExchange | null,
    private readonly log: Log,
  ) {}

  async connect(tenantId: string, input: SignupInput): Promise<SignupResult> {
    if (!this.exchange) throw new SignupUnavailableError()
    // First: the code expires 30 seconds after the owner finished.
    const token = await this.exchange.exchangeCode(input.code).catch((error: unknown) => {
      if (error instanceof WhatsAppApiError) throw new SignupCodeRejectedError()
      throw error
    })
    const grant = await fromMeta(this.exchange.inspect(token))
    if (!grant.valid || grant.appId !== this.exchange.appId || !grant.wabaIds.includes(input.wabaId)) throw new SignupGrantMismatchError()

    const found = await fromMeta(this.tenants.lookupNumbers(tenantId, input.wabaId, token))
    if (found.wabaTakenBy) throw new WabaTakenError()
    const number = found.numbers.find((n) => n.phoneNumberId === input.phoneNumberId)
    if (!number) throw new NumberNotInAccountError()
    if (number.takenBy) throw new NumberTakenError()

    const details = await fromMeta(this.waba.numberDetails(input.phoneNumberId, token))
    const pin = details.onBusinessApp ? undefined : newPin()
    if (pin) await fromMeta(this.waba.registerNumber(input.phoneNumberId, token, pin))

    const channelId = await this.saveChannel(tenantId, input, {
      displayNumber: details.displayNumber || number.displayNumber,
      label: (details.verifiedName || number.verifiedName || 'WhatsApp').slice(0, 40),
      coexistence: details.onBusinessApp,
      tokenExpiresAt: grant.expiresAt,
    })
    await this.credentials.store(tenantId, channelId, token, pin)

    // Without the subscription nothing arrives; the number is kept and the panel says so.
    const subscribed = await this.waba.subscribeApp(input.wabaId, token).then(
      () => true,
      () => false,
    )
    const syncRequested = details.onBusinessApp ? await this.requestSync(tenantId, input.phoneNumberId, token) : []
    return { channelId, displayNumber: details.displayNumber || number.displayNumber, coexistence: details.onBusinessApp, subscribed, tokenExpiresAt: grant.expiresAt, syncRequested }
  }

  /** The same number connected again (a new token) keeps its row: conversations stay with it. */
  private async saveChannel(
    tenantId: string,
    input: SignupInput,
    values: { displayNumber: string; label: string; coexistence: boolean; tokenExpiresAt: Date | null },
  ): Promise<string> {
    const { label, ...changes } = values
    const [existing] = await this.db
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.phoneNumberId, input.phoneNumberId)))
    if (existing) {
      await this.db
        .update(channelAccounts)
        // Connected again: whatever cut it before (the owner, Meta) no longer applies.
        .set({ ...changes, wabaId: input.wabaId, status: 'connected', statusReason: null, statusChangedAt: sql`now()` })
        .where(eq(channelAccounts.id, existing.id))
      return existing.id
    }
    const [created] = await this.db
      .insert(channelAccounts)
      .values({ tenantId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, label, ...changes })
      .returning({ id: channelAccounts.id })
    return created!.id
  }

  /** Each sync runs once per onboarding; a failure is logged (the owner can connect again within 24 h). */
  private async requestSync(tenantId: string, phoneNumberId: string, token: string): Promise<AppDataSync[]> {
    const done: AppDataSync[] = []
    for (const kind of ['smb_app_state_sync', 'history'] as const) {
      try {
        await this.waba.requestAppDataSync(phoneNumberId, token, kind)
        done.push(kind)
      } catch (error) {
        this.log.warn({ tenantId, phoneNumberId, kind, reason: error instanceof Error ? error.message : 'unknown' }, 'App data sync request failed')
      }
    }
    return done
  }
}

/** Six random digits: the number's two-step verification PIN. */
function newPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.ts'
import type { ChannelStatus, ChannelStatusReason } from '../../db/schema/enums.ts'
import { channelAccounts } from '../../db/schema/index.ts'
import type { AccountUpdateEvent } from '../whatsapp/events.ts'

/** What an account_update means for the account's numbers; null: nothing to change. */
export type StatusChange = { status: ChannelStatus; reason: ChannelStatusReason | null; onlyIfReason?: ChannelStatusReason }

/** PARTNER_REMOVED of a coexistence number: why Meta cut it (disconnection_info.reason). */
function disconnectedBecause(reason: string | null, initiatedBy: string | null): ChannelStatusReason {
  switch (reason ?? '') {
    case 'ACCOUNT_DISCONNECTED':
      return initiatedBy === 'SYSTEM' ? 'access_removed' : 'owner_disconnected'
    case 'CHANGE_NUMBER':
    case 'USER_RE_REGISTERED':
    case 'BUSINESS_DOWNGRADE':
      return 'number_changed'
    case 'PRIMARY_INACTIVITY':
    case 'COMPANION_INACTIVITY':
      return 'inactive'
    default:
      return initiatedBy === 'USER' ? 'owner_disconnected' : 'access_removed'
  }
}

/**
 * Meta's account_update, read as the state of the account's numbers. Only what changes whether the
 * number works is acted on; the rest (pricing tiers, verification, ads...) is acknowledged and left.
 */
export function statusChangeFor(event: AccountUpdateEvent): StatusChange | null {
  switch (event.event) {
    case 'PARTNER_REMOVED':
      return { status: 'disconnected', reason: disconnectedBecause(event.disconnection?.reason ?? null, event.disconnection?.initiatedBy ?? null) }
    case 'ACCOUNT_OFFBOARDED':
      return { status: 'disconnected', reason: 'number_changed' }
    case 'ACCOUNT_DELETED':
      return { status: 'disconnected', reason: 'account_deleted' }
    case 'ACCOUNT_RECONNECTED':
      return { status: 'connected', reason: null }
    case 'DISABLED_UPDATE':
      if (event.banState === 'REINSTATE') return { status: 'connected', reason: null, onlyIfReason: 'banned' }
      if (event.banState === 'SCHEDULE_FOR_DISABLE') return { status: 'restricted', reason: 'ban_scheduled' }
      if (event.banState === 'DISABLE') return { status: 'disconnected', reason: 'banned' }
      return null
    case 'ACCOUNT_RESTRICTION':
      // An empty list is the restriction lifted; it only clears a restriction, never another cause.
      return event.restrictions ? { status: 'restricted', reason: 'restricted' } : { status: 'connected', reason: null, onlyIfReason: 'restricted' }
    default:
      return null
  }
}

/**
 * Applies an account_update to every number of that account in the company that owns it. Runs as the
 * server (numbers are platform data: companies may only rename theirs). Repeating a webhook changes
 * nothing; a number connected again with «Conectar con WhatsApp» clears it (channel-signup-service).
 */
export class ChannelStatusService {
  constructor(private readonly db: Database) {}

  /** How many numbers changed. */
  async apply(tenantId: string, event: AccountUpdateEvent): Promise<number> {
    const change = statusChangeFor(event)
    if (!change) return 0
    const rows = await this.db
      .update(channelAccounts)
      .set({ status: change.status, statusReason: change.reason, statusChangedAt: sql`now()` })
      .where(
        and(
          eq(channelAccounts.tenantId, tenantId),
          eq(channelAccounts.wabaId, event.wabaId),
          change.onlyIfReason ? eq(channelAccounts.statusReason, change.onlyIfReason) : undefined,
          // Already in that state for that reason: nothing to change (and its date is kept).
          sql`(${channelAccounts.status}, coalesce(${channelAccounts.statusReason}, '')) is distinct from (${change.status}, ${change.reason ?? ''})`,
        ),
      )
      .returning({ id: channelAccounts.id })
    return rows.length
  }
}

import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { channelAccounts } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'

/** The company's WhatsApp numbers. Ids and labels only: the access token never leaves the server. */
export function listChannels(scope: MemberScope) {
  return scope.tx
    .select({
      id: channelAccounts.id,
      label: channelAccounts.label,
      displayNumber: channelAccounts.displayNumber,
      phoneNumberId: channelAccounts.phoneNumberId,
      wabaId: channelAccounts.wabaId,
      status: channelAccounts.status,
    })
    .from(channelAccounts)
    .where(eq(channelAccounts.tenantId, scope.tenantId))
    .orderBy(asc(channelAccounts.label))
}

export class ChannelNotFoundError extends Error {
  constructor() {
    super('Number not found in this company')
    this.name = 'ChannelNotFoundError'
  }
}

export const channelLabel = z.object({ label: z.string().trim().min(1).max(40) })

/** The name the team sees for a number ("Ventas"). The number itself is Meta's and never changes here. */
export async function renameChannel(scope: MemberScope, channelId: string, label: string) {
  const [row] = await scope.tx
    .update(channelAccounts)
    .set({ label })
    .where(and(eq(channelAccounts.tenantId, scope.tenantId), eq(channelAccounts.id, channelId)))
    .returning({ id: channelAccounts.id, label: channelAccounts.label })
  if (!row) throw new ChannelNotFoundError()
  return row
}

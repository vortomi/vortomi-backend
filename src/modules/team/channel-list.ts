import { asc, eq } from 'drizzle-orm'
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

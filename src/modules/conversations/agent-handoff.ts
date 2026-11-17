import { and, eq, sql } from 'drizzle-orm'
import { DEFAULT_HUMAN_PAUSE_MINUTES } from '../../db/schema/enums.ts'
import { agentSettings, conversations } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'

/**
 * Gives a conversation back to the sales agent: it may answer the customer's next message.
 * Done by hand («Devolver al agente») or when the team's work is over (resolved conversation,
 * order completed or cancelled), so a customer who writes again days later is answered at once.
 */
export async function returnToAgent(scope: TenantScope, conversationId: string): Promise<void> {
  await scope.tx
    .update(conversations)
    .set({ handoffAt: null, handoffReason: null, agentPausedUntil: null, agentPausedByUserId: null })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

/** How long the agent waits after someone of the company writes (Ajustes → Agente; 30 minutes by default). */
export async function humanPauseMs(scope: TenantScope): Promise<number> {
  const [row] = await scope.tx
    .select({ minutes: agentSettings.humanPauseMinutes })
    .from(agentSettings)
    .where(eq(agentSettings.tenantId, scope.tenantId))
  return (row?.minutes ?? DEFAULT_HUMAN_PAUSE_MINUTES) * 60_000
}

/**
 * Someone of the company wrote to the customer: a member of the team from the panel (`byUserId`), or
 * the owner from the WhatsApp Business app (null). The agent leaves the conversation to them for the
 * company's waiting time from that message. Only moves forward, so an older message arriving late
 * shortens nothing; the one who wrote last is the one it waits for.
 */
export async function pauseAgent(scope: TenantScope, conversationId: string, writtenAt: Date, byUserId: string | null): Promise<void> {
  const until = new Date(writtenAt.getTime() + (await humanPauseMs(scope))).toISOString()
  await scope.tx
    .update(conversations)
    .set({
      // Both read the row as it was: the author changes only if this message moves the pause.
      agentPausedByUserId: sql`case when ${until}::timestamptz >= coalesce(${conversations.agentPausedUntil}, '-infinity') then ${byUserId}::uuid else ${conversations.agentPausedByUserId} end`,
      agentPausedUntil: sql`greatest(${conversations.agentPausedUntil}, ${until}::timestamptz)`,
    })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

/** Whether someone of the company is still answering at `now`. */
export const pausedForPerson = (agentPausedUntil: Date | null, now: Date): boolean => agentPausedUntil !== null && agentPausedUntil > now

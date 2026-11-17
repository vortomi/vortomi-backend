import { and, eq, sql } from 'drizzle-orm'
import { conversations } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'

/**
 * Gives a conversation back to the sales agent: it may answer the customer's next message.
 * Done by hand («Devolver al agente») or when the team's work is over (resolved conversation,
 * order completed or cancelled), so a customer who writes again days later is answered at once.
 */
export async function returnToAgent(scope: TenantScope, conversationId: string): Promise<void> {
  await scope.tx
    .update(conversations)
    .set({ handoffAt: null, handoffReason: null, agentPausedUntil: null })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

/** How long the agent stays quiet after the owner writes from the phone (decided 2026-11-12). */
export const OWNER_REPLY_PAUSE_MS = 30 * 60_000

/**
 * The owner answered from the WhatsApp Business app: the agent leaves the conversation to them for
 * 30 minutes from that message. Only moves forward, so an older echo arriving late shortens nothing.
 */
export async function pauseForOwner(scope: TenantScope, conversationId: string, writtenAt: Date): Promise<void> {
  const until = new Date(writtenAt.getTime() + OWNER_REPLY_PAUSE_MS).toISOString()
  await scope.tx
    .update(conversations)
    .set({ agentPausedUntil: sql`greatest(${conversations.agentPausedUntil}, ${until}::timestamptz)` })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

/** Whether the owner's pause still holds at `now`. */
export const pausedForOwner = (agentPausedUntil: Date | null, now: Date): boolean => agentPausedUntil !== null && agentPausedUntil > now

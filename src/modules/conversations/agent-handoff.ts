import { and, eq } from 'drizzle-orm'
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
    .set({ handoffAt: null, handoffReason: null })
    .where(and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, conversationId)))
}

import { z } from 'zod'

/** Postgres channel the triggers announce on (drizzle/0022_inbox_change_notices.sql). */
export const INBOX_CHANNEL = 'vortomi_inbox'

/** Starts listening on a channel; resolves to the function that stops it. */
export type ListenFn = (channel: string, onNotice: (payload: string) => void) => Promise<() => Promise<void>>

/** What a panel is told: something in this conversation changed (or somewhere in the company). Never content. */
export interface InboxChange {
  conversationId: string | null
}

const noticeSchema = z.object({ t: z.uuid(), c: z.uuid().nullable() })

/**
 * Fans the database's change notices out to the panels open on each company. One listening
 * connection per server; each notice reaches only the subscribers of ITS company.
 */
export class InboxFeed {
  private readonly subscribers = new Map<string, Set<(change: InboxChange) => void>>()

  /** Starts hearing the database. Until then (tests that do not need it) nothing arrives. */
  start(listen: ListenFn): Promise<() => Promise<void>> {
    return listen(INBOX_CHANNEL, (payload) => this.deliver(payload))
  }

  /** Resolves to the function that unsubscribes. */
  subscribe(tenantId: string, listener: (change: InboxChange) => void): () => void {
    const set = this.subscribers.get(tenantId) ?? new Set()
    set.add(listener)
    this.subscribers.set(tenantId, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.subscribers.delete(tenantId)
    }
  }

  /** Malformed notices are dropped: they come from our own triggers, never from outside. */
  deliver(payload: string): void {
    let parsed: z.infer<typeof noticeSchema>
    try {
      parsed = noticeSchema.parse(JSON.parse(payload))
    } catch {
      return
    }
    for (const listener of this.subscribers.get(parsed.t) ?? []) listener({ conversationId: parsed.c })
  }
}

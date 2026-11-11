// A webhook that fails is retried by the sweep, waiting longer each time (×4), so an outage of
// hours does not use up every attempt in minutes; the last failure is said loudly; processed
// webhooks are purged after their time.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookEvents } from '../../src/db/schema/index.ts'
import { WebhookEventRepository } from '../../src/modules/inbox/webhook-event.repository.ts'
import { WebhookProcessor } from '../../src/modules/inbox/webhook-processor.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'

let t: TestDatabase
let repository: WebhookEventRepository
beforeAll(async () => {
  t = await createTestDatabase()
  repository = new WebhookEventRepository(t.db)
})
afterAll(async () => {
  await t.close()
})

const MINUTE = 60_000

async function storedAgo(ms: number, attempts: number, processed = false): Promise<number> {
  const at = new Date(Date.now() - ms)
  const [row] = await t.db
    .insert(webhookEvents)
    .values({ payload: {}, receivedAt: at, attempts, processedAt: processed ? at : null })
    .returning({ id: webhookEvents.id })
  return row!.id
}

describe('retrying failed webhooks', () => {
  it('waits longer after each failed attempt (30 s base: 30 s, 2 min, 8 min…)', async () => {
    const fresh = await storedAgo(MINUTE, 1) // failed once, 1 min old: its next try is at 2 min
    const due = await storedAgo(3 * MINUTE, 1)
    const thirdTry = await storedAgo(5 * MINUTE, 2) // twice: next at 8 min
    const ids = await repository.findPendingIds(new Date(Date.now() - 30_000), 7, 50, 30_000)
    expect(ids).toContain(due)
    expect(ids).not.toContain(fresh)
    expect(ids).not.toContain(thirdTry)
  })

  it('says loudly when the last attempt fails', async () => {
    const id = await storedAgo(MINUTE, 6)
    const errors: string[] = []
    const log = { warn: () => undefined, error: (_: object, msg: string) => void errors.push(msg) }
    const failing = { handle: () => Promise.reject(new Error('db down')) }
    const parse = () => ({ events: [{ kind: 'status_update', phoneNumberId: '1', waMessageId: 'w', status: 'sent', timestamp: new Date() }], skipped: [] })
    await new WebhookProcessor(repository, parse as never, failing, log, 7).process(id)
    expect(errors).toContain('Webhook event abandoned after its last attempt')
    const [row] = await t.db.select({ attempts: webhookEvents.attempts }).from(webhookEvents).where(eq(webhookEvents.id, id))
    expect(row!.attempts).toBe(7)
  })

  it('purges processed webhooks older than the cut, never pending ones', async () => {
    const old = await storedAgo(40 * 24 * 60 * MINUTE, 1, true)
    const recent = await storedAgo(MINUTE, 1, true)
    const pending = await storedAgo(40 * 24 * 60 * MINUTE, 7)
    await repository.purgeProcessed(new Date(Date.now() - 30 * 24 * 60 * MINUTE))
    const left = (await t.db.select({ id: webhookEvents.id }).from(webhookEvents)).map((r) => r.id)
    expect(left).not.toContain(old)
    expect(left).toContain(recent)
    expect(left).toContain(pending)
  })
})

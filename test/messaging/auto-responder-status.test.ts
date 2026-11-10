// A company suspended or cancelled from the console answers nothing by itself: neither the receipt
// collector, nor the sales agent, nor the away message. Its customers' messages are still stored.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tenants } from '../../src/db/schema/index.ts'
import { AutoResponder } from '../../src/modules/messaging/auto-responder.ts'
import { companyIsActive } from '../../src/modules/tenancy/company-status.ts'
import { silentLog } from '../helpers/app.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a } = await seedTwoTenants(t.db))
})
afterAll(async () => {
  await t.close()
})

function responder() {
  const asked: string[] = []
  const record = (who: string) => (tenantId: string) => {
    asked.push(`${who}:${tenantId === a.tenantId ? 'a' : '?'}`)
    return Promise.resolve(false)
  }
  const auto = new AutoResponder(
    { takes: record('agent') },
    { afterInbound: async (tenantId) => void (await record('away')(tenantId)) },
    silentLog,
    { takes: record('receipts') },
    companyIsActive(t.db),
  )
  return { auto, asked }
}

const trigger = { conversationId: '00000000-0000-0000-0000-000000000001', waMessageId: 'wamid.status', timestamp: new Date() }

describe('automatic answers follow the company status', () => {
  it('an active company answers as usual', async () => {
    const { auto, asked } = responder()
    await auto.afterInbound(a.tenantId, trigger)
    expect(asked).toEqual(['receipts:a', 'agent:a', 'away:a'])
  })

  it('a suspended or cancelled company answers nothing', async () => {
    for (const status of ['suspended', 'cancelled'] as const) {
      await t.db.update(tenants).set({ status }).where(eq(tenants.id, a.tenantId))
      const { auto, asked } = responder()
      await auto.afterInbound(a.tenantId, trigger)
      expect(asked).toEqual([])
    }
    await t.db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, a.tenantId))
  })
})

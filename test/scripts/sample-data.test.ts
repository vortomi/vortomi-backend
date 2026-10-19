// The prototype's sample data, loaded into the real schema: every row must pass every
// constraint, and the derived numbers (unread, stock) must match what the prototype shows.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { productVariants } from '../../src/db/schema/index.ts'
import { ConversationQueries } from '../../src/modules/conversations/conversation-queries.ts'
import { withMember } from '../../src/modules/access/member-scope.ts'
import { sampleUuid, seedSampleData } from '../../scripts/lib/sample-data.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'

const DATA_DIR = fileURLToPath(new URL('../../../vortomi-frontend/public/data', import.meta.url))

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t.close()
})

describe('sample data', () => {
  it('loads every company of the prototype under the real constraints', async () => {
    expect(await seedSampleData(t.db, DATA_DIR)).toMatchObject({ tenants: 7, conversations: 21, messages: 47 })
  })

  it('keeps the unread counts and the stock the prototype shows', async () => {
    const jose = await withMember(t.db, sampleUuid('ten_ra'), sampleUuid('usr_laura'), (scope) => new ConversationQueries().get(scope, sampleUuid('cnv_jose')))
    expect(jose).toMatchObject({ unreadCount: 0, assignedUserId: sampleUuid('usr_carlos') })
    const [bosch] = await t.db.select().from(productVariants).where(eq(productVariants.id, sampleUuid('var_brake_bosch')))
    expect(bosch).toMatchObject({ onHand: 6, reserved: 1 })
  })

  it('every conversation of Repuestos Andinos shows the unread count of the prototype', async () => {
    const expected = (JSON.parse(readFileSync(`${DATA_DIR}/conversations.json`, 'utf8')) as { id: string; tenantId: string; unreadCount: number }[])
      .filter((c) => c.tenantId === 'ten_ra')
      .map((c) => [sampleUuid(c.id), c.unreadCount])
      .sort()
    const { items } = await withMember(t.db, sampleUuid('ten_ra'), sampleUuid('usr_laura'), (scope) =>
      new ConversationQueries().list(scope, { view: 'all', limit: 100 }),
    )
    expect(items.map((c) => [c.id, c.unreadCount]).sort()).toEqual(expected)
  })

  it('gives Valeria a different role in each of her two companies', async () => {
    const role = (tenant: string) => withMember(t.db, sampleUuid(tenant), sampleUuid('usr_valeria'), (scope) => Promise.resolve(scope.member.role))
    expect([await role('ten_valle'), await role('ten_sonrisa')]).toEqual(['agent', 'admin'])
  })
})

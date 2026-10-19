// People and memberships under the same isolation as conversations: a company only
// reaches its own team, and the database refuses to mix two companies' people.
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, membershipChannels, memberships, users } from '../../src/db/schema/index.ts'
import { withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { seedMembership, seedUser } from '../helpers/auth.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { type SeededTenant, seedTwoTenants } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant
let laura: string
let valeria: string
let pedro: string

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  laura = await seedUser(t.db, 'Laura')
  valeria = await seedUser(t.db, 'Valeria')
  pedro = await seedUser(t.db, 'Pedro')
  await seedMembership(t.db, a.tenantId, laura, { role: 'admin' })
  await seedMembership(t.db, a.tenantId, valeria)
  await seedMembership(t.db, b.tenantId, valeria, { role: 'admin' })
  await seedMembership(t.db, b.tenantId, pedro, { channelAccountIds: [b.channelAccountId] })
})
afterAll(async () => {
  await t.close()
})

/** A new contact + conversation of company A, optionally assigned. */
const conversationInA = (waId: string, assignedUserId: string) =>
  withTenant(t.db, a.tenantId, async ({ tx, tenantId }) => {
    const [contact] = await tx.insert(contacts).values({ tenantId, channelAccountId: a.channelAccountId, waId }).returning()
    const [row] = await tx.insert(conversations).values({ tenantId, contactId: contact!.id, assignedUserId }).returning()
    return row!.assignedUserId
  })

describe('a company only sees its own team', () => {
  it('reads its own memberships and people, not the other company ones', async () => {
    const seen = await withTenant(t.db, a.tenantId, async ({ tx }) => ({
      members: await tx.select({ userId: memberships.userId }).from(memberships),
      people: await tx.select({ name: users.name }).from(users).orderBy(users.name),
      channels: await tx.select().from(membershipChannels),
    }))
    expect(seen.members.map((m) => m.userId).sort()).toEqual([laura, valeria].sort())
    // Valeria is in both companies; Pedro only in B, so A never learns he exists.
    expect(seen.people.map((p) => p.name)).toEqual(['Laura', 'Valeria'])
    expect(seen.channels).toEqual([])
  })

  it('cannot add a member to another company', async () => {
    const intrusion = withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.insert(memberships).values({ tenantId: b.tenantId, userId: laura, role: 'agent' }),
    )
    expect(await dbError(intrusion)).toMatch(/row-level security/)
  })

  it('cannot create people, nor delete memberships', async () => {
    const newPerson = withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.insert(users).values({ id: randomUUID(), email: 'x@example.com', name: 'X' }),
    )
    expect(await dbError(newPerson)).toMatch(/permission denied/)
    const removal = withTenant(t.db, a.tenantId, ({ tx }) => tx.delete(memberships).where(eq(memberships.userId, valeria)))
    expect(await dbError(removal)).toMatch(/permission denied/)
  })
})

describe('the database refuses to mix companies', () => {
  it('cannot give an agent a number of another company', async () => {
    const crossed = t.db.insert(membershipChannels).values({ tenantId: a.tenantId, userId: valeria, channelAccountId: b.channelAccountId })
    expect(await dbError(crossed)).toMatch(/membership_channels_channel_fk/)
  })

  it('cannot assign a conversation to someone of another company', async () => {
    expect(await dbError(conversationInA('584120000009', pedro))).toMatch(/conversations_assignee_fk/)
  })

  it('can assign it to a member of the same company', async () => {
    expect(await conversationInA('584120000010', valeria)).toBe(valeria)
  })
})

describe('membership rules', () => {
  it('an admin always sees conversations assigned to others', async () => {
    const blindAdmin = t.db.insert(memberships).values({ tenantId: b.tenantId, userId: laura, role: 'admin', canSeeOthers: false })
    expect(await dbError(blindAdmin)).toMatch(/memberships_admin_sees_all_check/)
  })

  it('stores emails normalised so the same address cannot sign up twice', async () => {
    const capitals = t.db.insert(users).values({ id: randomUUID(), email: 'Laura@Example.com', name: 'Laura 2' })
    expect(await dbError(capitals)).toMatch(/users_email_check/)
  })
})

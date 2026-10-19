import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../../src/db/schema/index.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, conversations, messages, messageStatusEvents, tenants, webhookEvents } from '../../src/db/schema/index.ts'
import { InvalidTenantIdError, withTenant } from '../../src/modules/tenancy/tenant-scope.ts'
import { dbError } from '../helpers/db-error.ts'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts'
import { seedTwoTenants, type SeededTenant } from '../helpers/tenants.ts'

let t: TestDatabase
let a: SeededTenant
let b: SeededTenant

/** A contact + conversation + message of one company, written as that company. */
async function seedConversation(tenant: SeededTenant, waId: string): Promise<{ contactId: string; conversationId: string }> {
  return withTenant(t.db, tenant.tenantId, async ({ tx, tenantId }) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, channelAccountId: tenant.channelAccountId, waId })
      .returning({ id: contacts.id })
    const [conversation] = await tx
      .insert(conversations)
      .values({ tenantId, contactId: contact!.id })
      .returning({ id: conversations.id })
    await tx.insert(messages).values({
      tenantId,
      conversationId: conversation!.id,
      waMessageId: `wamid.${waId}`,
      direction: 'in',
      author: 'customer',
      type: 'text',
      body: `hola desde ${waId}`,
    })
    return { contactId: contact!.id, conversationId: conversation!.id }
  })
}

beforeAll(async () => {
  t = await createTestDatabase()
  ;({ a, b } = await seedTwoTenants(t.db))
  await seedConversation(a, '584120000001')
  await seedConversation(b, '584120000002')
})
afterAll(async () => {
  await t.close()
})

describe('row level security everywhere', () => {
  it('is enabled on every public table', async () => {
    const { rows } = await t.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    )
    // Every table the schema declares exists, so a new one cannot slip in without RLS.
    const declared = Object.values(schema).filter((value) => is(value, PgTable)).map((table) => getTableName(table))
    expect(rows.map((row) => row.relname).sort()).toEqual(expect.arrayContaining(declared.sort()))
    expect(rows.length).toBeGreaterThanOrEqual(declared.length)
    expect(rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([])
  })

  it('gives every table with tenant_id an isolation policy', async () => {
    const { rows } = await t.client.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
        where c.table_schema = 'public' and c.column_name = 'tenant_id'
          and c.table_name in (select tablename from pg_tables where schemaname = 'public')
          and not exists (select 1 from pg_policies p where p.tablename = c.table_name and p.policyname = 'tenant_isolation')`,
    )
    expect(rows.map((row) => row.table_name)).toEqual([])
  })
})

describe('a company only reaches its own rows', () => {
  it('reads only its own messages, contacts and conversations', async () => {
    const seen = await withTenant(t.db, a.tenantId, async ({ tx }) => ({
      messages: await tx.select({ body: messages.body }).from(messages),
      contacts: await tx.select({ waId: contacts.waId }).from(contacts),
      tenants: await tx.select({ id: tenants.id }).from(tenants),
    }))
    expect(seen.messages).toEqual([{ body: 'hola desde 584120000001' }])
    expect(seen.contacts).toEqual([{ waId: '584120000001' }])
    expect(seen.tenants).toEqual([{ id: a.tenantId }])
  })

  it('cannot write a row for another company', async () => {
    const intrusion = withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.insert(contacts).values({ tenantId: b.tenantId, channelAccountId: b.channelAccountId, waId: '584129999999' }),
    )
    expect(await dbError(intrusion)).toMatch(/row-level security/)
  })

  it('cannot even update another company row it guessed the id of', async () => {
    const updated = await withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.update(contacts).set({ displayName: 'hackeado' }).where(sql`${contacts.tenantId} = ${b.tenantId}`).returning(),
    )
    expect(updated).toEqual([])
  })

  it('sees nothing at all when no company is set', async () => {
    const rows = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role tenant_scoped`)
      return tx.select({ id: messages.id }).from(messages)
    })
    expect(rows).toEqual([])
  })

  it('rejects a company id that is not a UUID before touching the database', async () => {
    await expect(withTenant(t.db, "' or 1=1 --", () => Promise.resolve())).rejects.toThrow(InvalidTenantIdError)
  })

  it('leaves no company or role behind on the connection', async () => {
    await withTenant(t.db, a.tenantId, () => Promise.resolve())
    const { rows } = await t.client.query<{ tenant: string | null; role: string }>(
      `select nullif(current_setting('app.tenant_id', true), '') as tenant, current_user as role`,
    )
    expect(rows[0]).toEqual({ tenant: null, role: 'postgres' })
  })
})

describe('least privilege for tenant-scoped code', () => {
  it('cannot create companies or read the platform webhook inbox', async () => {
    const newCompany = withTenant(t.db, a.tenantId, ({ tx }) =>
      tx.insert(tenants).values({ name: 'X', slug: 'x', plan: 'basic', legalName: 'X', taxId: 'J-41234567-8', fiscalAddress: 'X' }),
    )
    expect(await dbError(newCompany)).toMatch(/permission denied/)
    const inbox = withTenant(t.db, a.tenantId, ({ tx }) => tx.select().from(webhookEvents))
    expect(await dbError(inbox)).toMatch(/permission denied/)
  })

  it('cannot rewrite a stored message', async () => {
    const rewrite = withTenant(t.db, a.tenantId, ({ tx }) => tx.update(messages).set({ body: 'otro texto' }))
    expect(await dbError(rewrite)).toMatch(/permission denied/)
  })
})

describe('the database refuses cross-company links, even for the server role', () => {
  it('rejects a conversation of A pointing to a contact of B', async () => {
    const [contactOfB] = await t.db.select({ id: contacts.id }).from(contacts).where(sql`${contacts.tenantId} = ${b.tenantId}`)
    const link = t.db.insert(conversations).values({ tenantId: a.tenantId, contactId: contactOfB!.id })
    expect(await dbError(link)).toMatch(/conversations_contact_fk/)
  })

  it('rejects a contact of A on a number of B', async () => {
    const link = t.db.insert(contacts).values({ tenantId: a.tenantId, channelAccountId: b.channelAccountId, waId: '584128888888' })
    expect(await dbError(link)).toMatch(/contacts_channel_fk/)
  })

  it('never lets a number belong to two companies', async () => {
    const steal = t.client.query(
      `insert into channel_accounts (tenant_id, waba_id, phone_number_id, display_number, label) values ($1, '1', $2, 'x', 'x')`,
      [b.tenantId, a.phoneNumberId],
    )
    expect(await dbError(steal)).toMatch(/phone_number_id/)
  })
})

describe('delivery statuses are append-only', () => {
  it('refuses updates and deletes, even from the server role', async () => {
    await withTenant(t.db, a.tenantId, ({ tx, tenantId }) =>
      tx.insert(messageStatusEvents).values({ tenantId, waMessageId: 'wamid.out1', status: 'sent', occurredAt: new Date() }),
    )
    expect(await dbError(t.db.update(messageStatusEvents).set({ status: 'read' }))).toMatch(/append-only/)
    expect(await dbError(t.db.delete(messageStatusEvents))).toMatch(/append-only/)
  })
})

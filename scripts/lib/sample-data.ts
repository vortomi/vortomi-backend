// Loads the prototype's sample companies (vortomi-frontend/public/data/*.json) into
// the database, so the real backend can be tried with the same data the prototype shows.
// Development only. Runs as the server role in ONE transaction: all or nothing.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Database } from '../../src/db/client.ts'
import type { MessageType, TagTone, TemplateCategory, TemplateStatus } from '../../src/db/schema/enums.ts'
import type { CustomValue } from '../../src/db/schema/columns.ts'
import * as s from '../../src/db/schema/index.ts'

/** Stable UUID for a prototype id ("ten_ra"), so re-running maps to the same rows. */
export function sampleUuid(prototypeId: string): string {
  const hex = createHash('sha256').update(`vortomi-sample:${prototypeId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

type Row = Record<string, unknown>
const str = (row: Row, key: string) => row[key] as string
const opt = (row: Row, key: string) => (row[key] ?? null) as string | null
const date = (row: Row, key: string) => new Date(str(row, key))
const id = (row: Row, key = 'id') => sampleUuid(str(row, key))
const optId = (row: Row, key: string) => (row[key] ? sampleUuid(str(row, key)) : null)

export interface SeedSummary {
  tenants: number
  users: number
  conversations: number
  messages: number
  products: number
}

export async function seedSampleData(db: Database, dataDir: string): Promise<SeedSummary> {
  const load = (name: string) => JSON.parse(readFileSync(join(dataDir, `${name}.json`), 'utf8')) as Row[]
  const data = {
    tenants: load('tenants'),
    users: load('users'),
    channels: load('channel-accounts'),
    memberships: load('memberships'),
    settings: load('tenant-settings'),
    rateBooks: load('exchange-rates'),
    stages: load('pipeline-stages'),
    tags: load('tags'),
    quickReplies: load('quick-replies'),
    templates: load('templates'),
    contacts: load('contacts'),
    conversations: load('conversations'),
    messages: load('messages'),
    notes: load('notes'),
    categories: load('product-categories'),
    variantTypes: load('variant-types'),
    customFields: load('custom-fields'),
    variantOptions: load('variant-options'),
    products: load('products'),
    variants: load('product-variants'),
    movements: load('stock-movements'),
  }

  await db.transaction(async (tx) => {
    for (const t of data.tenants) {
      await tx.insert(s.tenants).values({
        id: id(t),
        name: str(t, 'name'),
        slug: str(t, 'slug'),
        status: str(t, 'status') as never,
        plan: str(t, 'plan') as never,
        timezone: str(t, 'timezone'),
        legalName: str(t, 'legalName'),
        taxId: str(t, 'taxId'),
        fiscalAddress: str(t, 'fiscalAddress'),
        createdAt: date(t, 'createdAt'),
      })
    }
    for (const u of data.users) {
      await tx.insert(s.users).values({ id: id(u), email: str(u, 'email').toLowerCase(), name: str(u, 'name'), platformRole: opt(u, 'platformRole') as never })
    }
    for (const c of data.channels) {
      await tx.insert(s.channelAccounts).values({
        id: id(c),
        tenantId: id(c, 'tenantId'),
        wabaId: str(c, 'wabaId'),
        phoneNumberId: str(c, 'phoneNumberId'),
        displayNumber: str(c, 'displayNumber'),
        label: str(c, 'label'),
        status: str(c, 'status') as never,
      })
    }
    for (const m of data.memberships) {
      const tenantId = id(m, 'tenantId')
      const userId = id(m, 'userId')
      await tx.insert(s.memberships).values({ tenantId, userId, role: str(m, 'role') as never, status: str(m, 'status') as never, canSeeOthers: m['canSeeOthers'] as boolean })
      for (const channel of m['channelAccountIds'] as string[]) {
        await tx.insert(s.membershipChannels).values({ tenantId, userId, channelAccountId: sampleUuid(channel) })
      }
    }
    for (const row of data.settings) {
      await tx.insert(s.tenantSettings).values({
        tenantId: id(row, 'tenantId'),
        workMode: (opt(row, 'workMode') ?? 'sales_and_support') as never,
        businessHours: row['businessHours'] as never,
        awayMessage: str(row, 'awayMessage'),
      })
    }
    for (const book of data.rateBooks) {
      const tenantId = id(book, 'tenantId')
      await tx.update(s.tenantSettings).set({ rateSource: str(book, 'rateSource') as never }).where(eq(s.tenantSettings.tenantId, tenantId))
      // Oldest first, with their dates: the newest stays the company's rate. Typed ones lose
      // their author's name (it is only text in the prototype).
      for (const rate of [...(book['exchangeRates'] as Row[])].reverse()) {
        await tx.insert(s.exchangeRates).values({
          tenantId,
          rate: str(rate, 'bsPerUsd'),
          previousRate: opt(rate, 'previousBsPerUsd') ?? null,
          effectiveDate: str(rate, 'effectiveDate'),
          source: str(rate, 'source') as never,
          createdAt: new Date(str(rate, 'createdAt')),
        })
      }
    }
    for (const row of data.stages) {
      await tx.insert(s.pipelineStages).values({ id: id(row), tenantId: id(row, 'tenantId'), name: str(row, 'name'), color: str(row, 'color'), position: row['position'] as number })
    }
    for (const row of data.tags) {
      await tx.insert(s.tags).values({ id: id(row), tenantId: id(row, 'tenantId'), name: str(row, 'name'), tone: str(row, 'tone') as TagTone })
    }
    for (const row of data.quickReplies) {
      await tx.insert(s.quickReplies).values({ id: id(row), tenantId: id(row, 'tenantId'), shortcut: str(row, 'shortcut'), title: str(row, 'title'), body: str(row, 'body') })
    }

    const wabaOf = new Map(data.channels.map((c) => [str(c, 'tenantId'), str(c, 'wabaId')]))
    for (const [index, row] of data.templates.entries()) {
      const status = str(row, 'status') as TemplateStatus
      await tx.insert(s.messageTemplates).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        wabaId: wabaOf.get(str(row, 'tenantId'))!,
        metaTemplateId: String(9_100_000 + index),
        name: str(row, 'name'),
        language: str(row, 'language'),
        category: str(row, 'category') as TemplateCategory,
        status,
        rejectionReason: opt(row, 'rejectionReason'),
        body: str(row, 'body'),
      })
    }

    const inboundAt = (conversationId: string) =>
      data.messages.filter((m) => m['conversationId'] === conversationId && m['direction'] === 'inbound').map((m) => date(m, 'createdAt'))
    for (const row of data.contacts) {
      const conversation = data.conversations.find((c) => c['contactId'] === row['id'])
      const lastInbound = conversation ? inboundAt(str(conversation, 'id')).sort((x, y) => y.getTime() - x.getTime())[0] : undefined
      await tx.insert(s.contacts).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        channelAccountId: id(row, 'channelAccountId'),
        waId: str(row, 'waId'),
        name: str(row, 'name'),
        stageId: optId(row, 'stageId'),
        quoteCents: (row['quoteCents'] ?? null) as number | null,
        lastInboundAt: lastInbound ?? null,
        createdAt: date(row, 'createdAt'),
      })
      for (const tag of row['tagIds'] as string[]) {
        await tx.insert(s.contactTags).values({ tenantId: id(row, 'tenantId'), contactId: id(row), tagId: sampleUuid(tag) })
      }
    }

    for (const row of data.conversations) {
      // Shared read mark placed so exactly `unreadCount` inbound messages stay unread.
      const inbound = inboundAt(str(row, 'id')).sort((x, y) => x.getTime() - y.getTime())
      const unread = row['unreadCount'] as number
      const lastReadAt = unread === 0 ? date(row, 'lastMessageAt') : (inbound[inbound.length - unread - 1] ?? null)
      await tx.insert(s.conversations).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        contactId: id(row, 'contactId'),
        assignedUserId: optId(row, 'assignedUserId'),
        status: str(row, 'status') as never,
        lastActivityAt: date(row, 'lastMessageAt'),
        lastReadAt,
      })
    }

    for (const row of data.messages) {
      const tenantId = id(row, 'tenantId')
      const inbound = row['direction'] === 'inbound'
      const author = inbound ? 'customer' : row['authorUserId'] ? 'staff' : 'bot'
      const waMessageId = `wamid.sample.${str(row, 'id')}`
      const at = date(row, 'createdAt')
      await tx.insert(s.messages).values({
        tenantId,
        conversationId: id(row, 'conversationId'),
        waMessageId,
        direction: inbound ? 'in' : 'out',
        author,
        authorUserId: author === 'staff' ? optId(row, 'authorUserId') : null,
        type: (str(row, 'type') === 'product' ? 'text' : str(row, 'type')) as MessageType,
        body: opt(row, 'body'),
        templateId: optId(row, 'templateId'),
        waTimestamp: at,
        createdAt: at,
      })
      const status = opt(row, 'status')
      if (!inbound && status && status !== 'pending') {
        const reached = status === 'failed' ? ['failed'] : ['sent', 'delivered', 'read'].slice(0, ['sent', 'delivered', 'read'].indexOf(status) + 1)
        for (const step of reached) {
          await tx.insert(s.messageStatusEvents).values({ tenantId, waMessageId, status: step as never, occurredAt: at, pricingCategory: row['templateId'] ? 'utility' : 'service' })
        }
      }
    }

    for (const row of data.notes) {
      await tx.insert(s.notes).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        conversationId: id(row, 'conversationId'),
        authorUserId: id(row, 'authorUserId'),
        mentionUserId: optId(row, 'mentionUserId'),
        body: str(row, 'body'),
        createdAt: date(row, 'createdAt'),
      })
    }

    for (const row of data.categories) {
      await tx.insert(s.productCategories).values({ id: id(row), tenantId: id(row, 'tenantId'), name: str(row, 'name') })
    }
    // The companies' own fields, then the answers the prototype gives to products and contacts.
    const kindOf = new Map<string, string>()
    for (const row of data.customFields) {
      kindOf.set(str(row, 'id'), str(row, 'kind'))
      const fieldId = id(row)
      const tenantId = id(row, 'tenantId')
      await tx.insert(s.customFields).values({
        id: fieldId,
        tenantId,
        entity: str(row, 'entity') as never,
        label: str(row, 'label'),
        kind: str(row, 'kind') as never,
        required: row['required'] as boolean,
        position: row['position'] as number,
      })
      for (const [position, option] of (row['options'] as Row[]).entries()) {
        await tx.insert(s.customFieldOptions).values({ id: id(option), tenantId, fieldId, value: str(option, 'value'), position })
      }
      for (const categoryId of row['categoryIds'] as string[]) {
        await tx.insert(s.customFieldCategories).values({ tenantId, fieldId, categoryId: sampleUuid(categoryId) })
      }
    }
    // Prototype ids become the sample uuids: the field keys and, for lists, the options picked.
    const answers = (row: Row) => {
      const stored: Record<string, CustomValue> = {}
      for (const [fieldId, value] of Object.entries((row['customValues'] as Record<string, CustomValue> | undefined) ?? {})) {
        const kind = kindOf.get(fieldId)
        stored[sampleUuid(fieldId)] = kind === 'choice' ? sampleUuid(value as string) : kind === 'multi_choice' ? (value as string[]).map(sampleUuid) : value
      }
      return stored
    }
    for (const row of data.contacts) {
      const customValues = answers(row)
      if (Object.keys(customValues).length) await tx.update(s.contacts).set({ customValues }).where(eq(s.contacts.id, id(row)))
    }

    for (const row of data.variantTypes) {
      await tx.insert(s.variantTypes).values({ id: id(row), tenantId: id(row, 'tenantId'), name: str(row, 'name') })
    }
    for (const row of data.variantOptions) {
      await tx.insert(s.variantOptions).values({ id: id(row), tenantId: id(row, 'tenantId'), typeId: id(row, 'typeId'), value: str(row, 'value') })
    }
    // Up to three types per product, and one value of each per variant, in the same order.
    const ids = (row: Row, key: string) => ((row[key] as string[] | undefined) ?? []).map(sampleUuid)
    const typesOf = new Map<string, string[]>()
    for (const row of data.products) {
      const typeIds = ids(row, 'variantTypeIds')
      typesOf.set(id(row), typeIds)
      await tx.insert(s.products).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        name: str(row, 'name'),
        categoryId: optId(row, 'categoryId'),
        variantTypeId: typeIds[0] ?? null,
        variantType2Id: typeIds[1] ?? null,
        variantType3Id: typeIds[2] ?? null,
        description: str(row, 'description'),
        stockMode: str(row, 'stockMode') as never,
        saleUnit: (opt(row, 'saleUnit') ?? 'unit') as never,
        minQuantity: (row['minQuantity'] as number | undefined) ?? 1,
        quantityStep: (row['quantityStep'] as number | undefined) ?? 1,
        customValues: answers(row),
        active: row['active'] as boolean,
        createdAt: date(row, 'createdAt'),
      })
    }
    for (const row of data.variants) {
      const typeIds = typesOf.get(id(row, 'productId')) ?? []
      const optionIds = ids(row, 'optionIds')
      const typed = optionIds.length > 0
      await tx.insert(s.productVariants).values({
        id: id(row),
        tenantId: id(row, 'tenantId'),
        productId: id(row, 'productId'),
        variantTypeId: typed ? (typeIds[0] ?? null) : null,
        optionId: optionIds[0] ?? null,
        variantType2Id: typed ? (typeIds[1] ?? null) : null,
        option2Id: optionIds[1] ?? null,
        variantType3Id: typed ? (typeIds[2] ?? null) : null,
        option3Id: optionIds[2] ?? null,
        name: str(row, 'name'),
        sku: str(row, 'sku'),
        priceCents: row['priceCents'] as number,
        available: row['available'] as boolean,
        lowStockThreshold: row['lowStockThreshold'] as number,
      })
    }
    // Stock arrives the only way it can: as movements (the trigger keeps on_hand).
    for (const row of data.movements) {
      await tx.insert(s.stockMovements).values({
        tenantId: id(row, 'tenantId'),
        variantId: id(row, 'variantId'),
        kind: str(row, 'kind') as never,
        quantity: row['quantity'] as number,
        reason: str(row, 'reason'),
        userId: id(row, 'userId'),
        createdAt: date(row, 'createdAt'),
      })
    }
    // Reservations have no flow of their own yet: set as the prototype shows them.
    for (const row of data.variants) {
      if ((row['reserved'] as number) > 0) await tx.update(s.productVariants).set({ reserved: row['reserved'] as number }).where(eq(s.productVariants.id, id(row)))
    }
  })

  return {
    tenants: data.tenants.length,
    users: data.users.length,
    conversations: data.conversations.length,
    messages: data.messages.length,
    products: data.products.length,
  }
}

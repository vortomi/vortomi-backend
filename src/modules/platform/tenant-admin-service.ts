import { and, asc, count, eq, gt, inArray, max, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { TENANT_PLANS } from '../../db/schema/enums.ts'
import { timeZone } from '../../shared/time-zone.ts'
import { channelAccounts, channelCredentials, memberships, messages, tenants, users } from '../../db/schema/index.ts'
import type { ChannelCredentials } from '../channels/channel-credentials.ts'
import type { InvitationService } from '../team/invitation-service.ts'
import type { WabaDirectory } from '../whatsapp/cloud-api.client.ts'

export class TenantNotFoundError extends Error {
  constructor() {
    super('Company not found')
    this.name = 'TenantNotFoundError'
  }
}

export class NoChannelError extends Error {
  constructor() {
    super('A company goes live only with a connected number')
    this.name = 'NoChannelError'
  }
}

export class WabaTakenError extends Error {
  constructor() {
    super('That WhatsApp Business Account belongs to another company')
    this.name = 'WabaTakenError'
  }
}

/** "j 41.234.567 8" -> "J-41234567-8"; only the shape is checked (documentations/03). */
const taxId = z
  .string()
  .transform((raw) => raw.toUpperCase().replace(/[^JVEGPC0-9]/g, ''))
  .refine((clean) => /^[JVEGPC]\d{9}$/.test(clean), 'RIF: letra y 9 dígitos')
  .transform((clean) => `${clean[0]}-${clean.slice(1, 9)}-${clean[9]}`)


export const tenantInput = z.object({
  name: z.string().trim().min(1).max(80),
  industry: z.string().trim().max(60).default(''),
  city: z.string().trim().max(60).default(''),
  timezone: timeZone.default('America/Caracas'),
  plan: z.enum(TENANT_PLANS),
  legalName: z.string().trim().min(1).max(160),
  taxId,
  fiscalAddress: z.string().trim().min(1).max(300),
})
export type TenantInput = z.infer<typeof tenantInput>

export const tenantStatusInput = z.object({ status: z.enum(['active', 'suspended', 'cancelled']) })

const digits = z.string().trim().regex(/^\d{5,25}$/)
export const lookupInput = z.object({ wabaId: digits, accessToken: z.string().trim().min(20).max(1024) })
export const channelInput = lookupInput.extend({
  phoneNumberId: digits,
  displayNumber: z.string().trim().min(5).max(30),
  label: z.string().trim().min(1).max(40),
})
export type ChannelInput = z.infer<typeof channelInput>

export const adminInvitationInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().transform((email) => email.trim().toLowerCase()),
})

const slugify = (text: string) =>
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'empresa'

const tenantColumns = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  status: tenants.status,
  plan: tenants.plan,
  industry: tenants.industry,
  city: tenants.city,
  timezone: tenants.timezone,
  legalName: tenants.legalName,
  taxId: tenants.taxId,
  fiscalAddress: tenants.fiscalAddress,
  createdAt: tenants.createdAt,
}

/**
 * The platform console's work on companies (our own team, server role). Platform data only:
 * names, numbers, people and counts. Nothing here reads a conversation or a contact; the
 * sign-up test only learns WHEN a message arrived, never what it says.
 */
export class TenantAdminService {
  constructor(
    private readonly db: Database,
    private readonly invitations: InvitationService,
    private readonly credentials: ChannelCredentials,
    private readonly waba: WabaDirectory,
  ) {}

  async list() {
    const [rows, channels, people] = await Promise.all([
      this.db.select(tenantColumns).from(tenants).orderBy(asc(tenants.name)),
      this.db
        .select({ tenantId: channelAccounts.tenantId, id: channelAccounts.id, label: channelAccounts.label, displayNumber: channelAccounts.displayNumber, status: channelAccounts.status })
        .from(channelAccounts)
        .orderBy(asc(channelAccounts.label)),
      this.db
        .select({ tenantId: memberships.tenantId, total: count() })
        .from(memberships)
        .where(eq(memberships.status, 'active'))
        .groupBy(memberships.tenantId),
    ])
    const totals = new Map(people.map((p) => [p.tenantId, p.total]))
    return rows.map((tenant) => ({
      ...tenant,
      channels: channels.filter((c) => c.tenantId === tenant.id).map(({ tenantId: _t, ...c }) => c),
      memberCount: totals.get(tenant.id) ?? 0,
    }))
  }

  async detail(tenantId: string) {
    const tenant = await this.tenant(tenantId)
    const [channels, people, invitations] = await Promise.all([
      this.db
        .select({
          id: channelAccounts.id,
          label: channelAccounts.label,
          displayNumber: channelAccounts.displayNumber,
          phoneNumberId: channelAccounts.phoneNumberId,
          wabaId: channelAccounts.wabaId,
          status: channelAccounts.status,
          // Whether it can send: the token itself never leaves the server.
          hasToken: sql<boolean>`exists (select 1 from ${channelCredentials} cc where cc.channel_account_id = ${channelAccounts.id})`,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.tenantId, tenantId))
        .orderBy(asc(channelAccounts.label)),
      this.db
        .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, status: memberships.status })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, tenantId))
        .orderBy(asc(users.name)),
      this.invitations.listIn(this.db, tenantId),
    ])
    return { ...tenant, channels, members: people, invitations }
  }

  /** A new company starts as a draft: nobody can enter it until it is activated. */
  async create(input: TenantInput) {
    const slug = await this.freeSlug(slugify(input.name))
    const [row] = await this.db.insert(tenants).values({ ...input, slug, status: 'draft' }).returning(tenantColumns)
    return row!
  }

  async update(tenantId: string, input: TenantInput) {
    const [row] = await this.db.update(tenants).set(input).where(eq(tenants.id, tenantId)).returning(tenantColumns)
    if (!row) throw new TenantNotFoundError()
    return row
  }

  /** Live only with a number; suspending keeps every row and only closes the door. */
  async setStatus(tenantId: string, status: 'active' | 'suspended' | 'cancelled') {
    await this.tenant(tenantId)
    if (status === 'active') {
      const [channel] = await this.db.select({ id: channelAccounts.id }).from(channelAccounts).where(eq(channelAccounts.tenantId, tenantId)).limit(1)
      if (!channel) throw new NoChannelError()
    }
    await this.db.update(tenants).set({ status }).where(eq(tenants.id, tenantId))
  }

  /** The numbers of an account, and whether each one is already in Vortomi (here or elsewhere). */
  async lookupNumbers(tenantId: string, wabaId: string, accessToken: string) {
    await this.tenant(tenantId)
    const owner = await this.wabaOwner(wabaId, tenantId)
    const numbers = await this.waba.listNumbers(wabaId, accessToken)
    const known = numbers.length
      ? await this.db
          .select({ phoneNumberId: channelAccounts.phoneNumberId, tenantId: channelAccounts.tenantId, tenantName: tenants.name })
          .from(channelAccounts)
          .innerJoin(tenants, eq(tenants.id, channelAccounts.tenantId))
          .where(inArray(channelAccounts.phoneNumberId, numbers.map((n) => n.phoneNumberId)))
      : []
    return {
      wabaTakenBy: owner,
      numbers: numbers.map((n) => {
        const taken = known.find((k) => k.phoneNumberId === n.phoneNumberId)
        return { ...n, takenBy: taken && taken.tenantId !== tenantId ? taken.tenantName : null, alreadyHere: taken?.tenantId === tenantId }
      }),
    }
  }

  /**
   * Stores the number for the company with its token (encrypted), and subscribes our app to
   * the account so its messages reach us. A draft moves to "awaiting the number test".
   */
  async connectChannel(tenantId: string, input: ChannelInput) {
    const tenant = await this.tenant(tenantId)
    if (await this.wabaOwner(input.wabaId, tenantId)) throw new WabaTakenError()
    const [channel] = await this.db
      .insert(channelAccounts)
      .values({ tenantId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayNumber: input.displayNumber, label: input.label })
      .returning({ id: channelAccounts.id })
    await this.credentials.store(tenantId, channel!.id, input.accessToken)
    if (tenant.status === 'draft') await this.db.update(tenants).set({ status: 'awaiting_channel' }).where(eq(tenants.id, tenantId))
    // Without the subscription nothing arrives; the number is kept and the console says so.
    const subscribed = await this.waba.subscribeApp(input.wabaId, input.accessToken).then(
      () => true,
      () => false,
    )
    return { id: channel!.id, subscribed }
  }

  /** The sign-up test: has a customer message reached this company since `since`? When, not what. */
  async lastInbound(tenantId: string, since: Date) {
    await this.tenant(tenantId)
    const [row] = await this.db
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.direction, 'in'), gt(messages.createdAt, since)))
    return { receivedAt: row?.at ?? null }
  }

  /** The company's first admin: every number, sees everything. The link comes back once. */
  async inviteAdmin(tenantId: string, input: { name: string; email: string }, invitedBy: string) {
    await this.tenant(tenantId)
    const channels = await this.db.select({ id: channelAccounts.id }).from(channelAccounts).where(eq(channelAccounts.tenantId, tenantId))
    return this.invitations.createIn(
      this.db,
      tenantId,
      { ...input, role: 'admin', canSeeOthers: true, channelAccountIds: channels.map((c) => c.id) },
      invitedBy,
    )
  }

  async renewInvitation(tenantId: string, invitationId: string) {
    return this.invitations.renewIn(this.db, tenantId, invitationId)
  }

  async revokeInvitation(tenantId: string, invitationId: string) {
    return this.invitations.revokeIn(this.db, tenantId, invitationId)
  }

  private async tenant(tenantId: string) {
    const [row] = await this.db.select(tenantColumns).from(tenants).where(eq(tenants.id, tenantId))
    if (!row) throw new TenantNotFoundError()
    return row
  }

  /** The other company that already has this account, if any (one company per account, 0011). */
  private async wabaOwner(wabaId: string, tenantId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ name: tenants.name })
      .from(channelAccounts)
      .innerJoin(tenants, eq(tenants.id, channelAccounts.tenantId))
      .where(and(eq(channelAccounts.wabaId, wabaId), ne(channelAccounts.tenantId, tenantId)))
      .limit(1)
    return row?.name ?? null
  }

  private async freeSlug(base: string): Promise<string> {
    const taken = await this.db.select({ slug: tenants.slug }).from(tenants).where(sql`${tenants.slug} like ${`${base}%`}`)
    const used = new Set(taken.map((t) => t.slug))
    if (!used.has(base)) return base
    for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
  }
}

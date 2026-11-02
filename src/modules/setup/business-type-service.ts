import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../../db/client.ts'
import { businessTypes, tenants } from '../../db/schema/index.ts'

export const newTypeInput = z.object({
  label: z.string().trim().min(2).max(60),
  // The companies that wrote it under «Otro», moved to the new type at once.
  tenantIds: z.array(z.uuid()).max(500).default([]),
})
export const reclassifyInput = z.object({ businessType: z.string().regex(/^[a-z0-9_]{2,40}$/), tenantIds: z.array(z.uuid()).min(1).max(500) })

/** "Óptica", "optica " and "Óptica." are the same request. */
const key = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * The platform's list of business types: everyone reads it; our console adds types from what
 * companies wrote under «Otro» and moves those companies to them. Platform data (server role).
 */
export class BusinessTypeService {
  constructor(private readonly db: Database) {}

  list(executor: Executor = this.db) {
    return executor.select({ code: businessTypes.code, label: businessTypes.label, icon: businessTypes.icon }).from(businessTypes).orderBy(asc(businessTypes.position), asc(businessTypes.label))
  }

  /** What companies wrote under «Otro», grouped by meaning, most companies first. */
  async unclassified() {
    const rows = await this.db
      .select({ id: tenants.id, name: tenants.name, text: tenants.businessTypeOther })
      .from(tenants)
      .where(eq(tenants.businessType, 'other'))
    const groups = new Map<string, { text: string; tenants: { id: string; name: string }[] }>()
    for (const row of rows) {
      if (!row.text.trim()) continue
      const group = groups.get(key(row.text)) ?? { text: row.text.trim(), tenants: [] }
      group.tenants.push({ id: row.id, name: row.name })
      groups.set(key(row.text), group)
    }
    return [...groups.values()].sort((a, b) => b.tenants.length - a.tenants.length || a.text.localeCompare(b.text, 'es'))
  }

  /** A new type on the list (it gets the general preset), with the companies that asked for it. */
  async create(label: string, tenantIds: string[]) {
    return this.db.transaction(async (tx) => {
      const base = key(label).replace(/ /g, '_').slice(0, 36) || 'type'
      const taken = new Set((await tx.select({ code: businessTypes.code }).from(businessTypes)).map((r) => r.code))
      let code = base
      for (let n = 2; taken.has(code); n++) code = `${base}_${n}`
      const [type] = await tx.insert(businessTypes).values({ code, label }).returning({ code: businessTypes.code, label: businessTypes.label, icon: businessTypes.icon })
      if (tenantIds.length) await tx.update(tenants).set({ businessType: code, businessTypeOther: '' }).where(inArray(tenants.id, tenantIds))
      return type!
    })
  }

  /** Moves companies to a type of the list; what they wrote under «Otro» is no longer needed. */
  async reclassify(businessType: string, tenantIds: string[]) {
    const moved = await this.db
      .update(tenants)
      .set({ businessType, businessTypeOther: '' })
      .where(inArray(tenants.id, tenantIds))
      .returning({ id: tenants.id })
    return { moved: moved.length }
  }
}

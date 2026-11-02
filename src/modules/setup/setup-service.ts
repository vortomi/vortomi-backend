import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SELLS, SELL_METHODS, type SaleUnit, type SellMethod, type StockMode } from '../../db/schema/enums.ts'
import { businessTypes, productCategories, tags, tenantSettings, tenants, variantOptions, variantTypes } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { type CustomFieldService, MAX_FIELDS } from '../custom-fields/custom-field-service.ts'
import { type PresetField, presetFor } from './business-presets.ts'

/** A business type that is not on the platform's list. */
export class UnknownBusinessTypeError extends Error {
  constructor() {
    super('Unknown business type')
    this.name = 'UnknownBusinessTypeError'
  }
}

/** The parts of the plan the person can keep or leave out. */
export const PLAN_PARTS = ['workMode', 'saleDefaults', 'categories', 'productFields', 'contactFields', 'variantTypes', 'tags'] as const
export type PlanPart = (typeof PLAN_PARTS)[number]

const answerFields = z.object({
  businessType: z.string().regex(/^[a-z0-9_]{2,40}$/),
  // What they wrote under «Otro»: required there, ignored elsewhere.
  businessTypeOther: z.string().trim().max(60).default(''),
  sells: z.enum(SELLS),
  sellMethod: z.enum(SELL_METHODS),
})
const otherNamed = (a: { businessType: string; businessTypeOther: string }) => a.businessType !== 'other' || a.businessTypeOther.length >= 3
const otherMessage = { message: 'Write the business type', path: ['businessTypeOther'] }

export const answersInput = answerFields.refine(otherNamed, otherMessage)
export type Answers = z.infer<typeof answersInput>
export const applyInput = answerFields.extend({ include: z.array(z.enum(PLAN_PARTS)).max(PLAN_PARTS.length) }).refine(otherNamed, otherMessage)
export type ApplyInput = z.infer<typeof applyInput>

/** One thing the plan would create; `exists` when the company already has it (left untouched). */
export interface PlanItem {
  name: string
  /** The values of a variant type or list field: "S, M, L". */
  detail: string
  exists: boolean
}

/** «¿Cómo vendes?» → what a new product starts with. Mixed starts by the unit. */
const SALE_UNIT_FOR: Record<SellMethod, SaleUnit> = { unit: 'unit', weight: 'kg', measure: 'm', time: 'hour', mixed: 'unit' }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The welcome (block C): the company's answers (business type, what and how it sells) and the
 * starting point they prepare. Applying only adds what is missing, by name: nothing the
 * company already has is changed or deleted, and running it again is harmless.
 */
export class SetupService {
  constructor(private readonly customFields: CustomFieldService) {}

  async status(scope: MemberScope) {
    const [row] = await scope.tx
      .select({
        businessType: tenants.businessType,
        businessTypeOther: tenants.businessTypeOther,
        sells: tenants.sells,
        sellMethod: tenants.sellMethod,
        completedAt: tenants.setupCompletedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId))
    return row!
  }

  /** What applying these answers would prepare, marking what the company already has. */
  async plan(scope: MemberScope, answers: Answers) {
    await this.assertType(scope, answers.businessType)
    const preset = presetFor(answers.businessType)
    const solo = answers.sells === 'none'
    const [categories, productFields, contactFields, types, tagRows] = await Promise.all([
      scope.tx.select({ name: productCategories.name }).from(productCategories).where(eq(productCategories.tenantId, scope.tenantId)),
      this.customFields.list(scope, 'product'),
      this.customFields.list(scope, 'contact'),
      scope.tx.select({ name: variantTypes.name }).from(variantTypes).where(eq(variantTypes.tenantId, scope.tenantId)),
      scope.tx.select({ name: tags.name }).from(tags).where(eq(tags.tenantId, scope.tenantId)),
    ])
    const namesOf = (rows: { name: string }[]) => rows.map((r) => r.name)
    const item = (taken: readonly string[], name: string, values: string[] = []): PlanItem => ({
      name,
      detail: values.join(', '),
      exists: taken.some((t) => sameName(t, name)),
    })
    const fieldItems = (fields: PresetField[], existing: { label: string }[]) =>
      fields.map((f) =>
        item(
          existing.map((e) => e.label),
          f.label,
          f.options,
        ),
      )
    return {
      // Only attending customers hides inventory and the pipeline; otherwise the mode stays.
      workMode: solo ? ('support_only' as const) : null,
      saleDefaults: solo ? null : this.saleDefaults(answers),
      categories: solo ? [] : preset.categories.map((name) => item(namesOf(categories), name)),
      productFields: solo ? [] : fieldItems(preset.productFields, productFields),
      contactFields: fieldItems(preset.contactFields, contactFields),
      variantTypes: solo ? [] : preset.variantTypes.map((v) => item(namesOf(types), v.name, v.values)),
      tags: preset.tags.map((t) => item(namesOf(tagRows), t.name)),
    }
  }

  /** Saves the answers, prepares the parts kept, and closes the welcome. Resolves to what was created. */
  async apply(scope: MemberScope, input: ApplyInput) {
    const { tx, tenantId } = scope
    const { include, ...answers } = input
    await this.assertType(scope, answers.businessType)
    const keep = new Set(include)
    const preset = presetFor(answers.businessType)
    const solo = answers.sells === 'none'
    const created = { categories: 0, productFields: 0, contactFields: 0, variantTypes: 0, tags: 0 }

    await tx
      .update(tenants)
      .set({
        businessType: answers.businessType,
        businessTypeOther: answers.businessType === 'other' ? answers.businessTypeOther : '',
        sells: answers.sells,
        sellMethod: answers.sellMethod,
        setupCompletedAt: sql`now()`,
      })
      .where(eq(tenants.id, tenantId))

    if (keep.has('workMode') && solo) await this.settings(scope, { workMode: 'support_only' })
    if (keep.has('saleDefaults') && !solo) await this.settings(scope, this.saleDefaults(answers))

    if (keep.has('categories') && !solo) {
      for (const name of preset.categories) {
        const rows = await tx.insert(productCategories).values({ tenantId, name }).onConflictDoNothing().returning({ id: productCategories.id })
        created.categories += rows.length
      }
    }
    if (keep.has('variantTypes') && !solo) {
      for (const type of preset.variantTypes) {
        const rows = await tx.insert(variantTypes).values({ tenantId, name: type.name }).onConflictDoNothing().returning({ id: variantTypes.id })
        created.variantTypes += rows.length
        const [found] = await tx
          .select({ id: variantTypes.id })
          .from(variantTypes)
          .where(and(eq(variantTypes.tenantId, tenantId), sql`lower(${variantTypes.name}) = lower(${type.name})`))
        for (const value of type.values) await tx.insert(variantOptions).values({ tenantId, typeId: found!.id, value }).onConflictDoNothing()
      }
    }
    if (keep.has('productFields') && !solo) created.productFields = await this.addFields(scope, 'product', preset.productFields)
    if (keep.has('contactFields')) created.contactFields = await this.addFields(scope, 'contact', preset.contactFields)
    if (keep.has('tags')) {
      for (const tag of preset.tags) {
        const rows = await tx.insert(tags).values({ tenantId, ...tag }).onConflictDoNothing().returning({ id: tags.id })
        created.tags += rows.length
      }
    }
    return { created, status: await this.status(scope) }
  }

  /** «Lo hago después»: the welcome stops opening by itself; Ajustes can still open it. */
  async skip(scope: MemberScope) {
    await scope.tx.update(tenants).set({ setupCompletedAt: sql`coalesce(${tenants.setupCompletedAt}, now())` }).where(eq(tenants.id, scope.tenantId))
    return this.status(scope)
  }

  private saleDefaults(answers: Answers): { defaultSaleUnit: SaleUnit; defaultStockMode: StockMode } {
    return { defaultSaleUnit: SALE_UNIT_FOR[answers.sellMethod], defaultStockMode: answers.sells === 'services' ? 'availability' : 'units' }
  }

  private async settings(scope: MemberScope, values: Partial<typeof tenantSettings.$inferInsert>) {
    await scope.tx
      .insert(tenantSettings)
      .values({ tenantId: scope.tenantId, ...values })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { ...values, updatedAt: sql`now()` } })
  }

  /** The preset's fields the company does not have yet, within the limit; product fields in their categories. */
  private async addFields(scope: MemberScope, entity: 'product' | 'contact', fields: PresetField[]) {
    const existing = await this.customFields.list(scope, entity)
    let room = MAX_FIELDS - existing.length
    let added = 0
    for (const field of fields) {
      if (room <= 0) break
      if (existing.some((e) => sameName(e.label, field.label))) continue
      const categoryIds = field.categories?.length ? await this.categoryIds(scope, field.categories) : []
      await this.customFields.create(scope, {
        entity,
        label: field.label,
        kind: field.kind,
        required: false,
        options: field.options ?? [],
        categoryIds: entity === 'product' ? categoryIds : [],
      })
      room--
      added++
    }
    return added
  }

  private async categoryIds(scope: MemberScope, names: string[]) {
    const rows = await scope.tx
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, scope.tenantId), inArray(sql`lower(${productCategories.name})`, names.map((n) => n.toLowerCase()))))
    return rows.map((r) => r.id)
  }

  private async assertType(scope: MemberScope, code: string) {
    const [row] = await scope.tx.select({ code: businessTypes.code }).from(businessTypes).where(eq(businessTypes.code, code))
    if (!row) throw new UnknownBusinessTypeError()
  }
}

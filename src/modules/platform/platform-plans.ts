import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { platformPlans } from '../../db/schema/index.ts'

/** The periods a plan sets a discount for; a company may pay any number of months (tiers: «from»). */
export const PLAN_PERIODS = ['1', '3', '6', '12'] as const
export type PlanPeriod = (typeof PLAN_PERIODS)[number]
export type PlanDiscounts = Record<PlanPeriod, number>

const percent = z.number().int().min(0).max(90)

/** What the editor sends: everything about a plan. Being active is its own route (the switch). */
export const planInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500),
  priceCents: z.number().int().min(1).max(10_000_000),
  discounts: z.object({ '1': percent, '3': percent, '6': percent, '12': percent }),
  benefits: z.array(z.string().trim().min(1).max(120)).max(12),
})
export type PlanInput = z.infer<typeof planInput>

export const newPlanInput = planInput.extend({ isActive: z.boolean() })
export type NewPlanInput = z.infer<typeof newPlanInput>

export const planActiveInput = z.object({ isActive: z.boolean() })

export interface PlanView extends PlanInput {
  id: string
  isActive: boolean
  /** Companies subscribed to it: a plan with any is never deleted, only suspended. */
  companies: number
}

/**
 * How many companies are on each plan. Companies are not linked to these plans yet (they still use
 * the fixed internal/basic/team list), so for now none; when subscriptions exist, they answer here.
 */
export interface PlanSubscribers {
  count(planIds: string[]): Promise<Map<string, number>>
}

export const noSubscribersYet: PlanSubscribers = { count: async () => new Map() }

export class PlanNotFoundError extends Error {
  constructor() {
    super('Plan not found')
    this.name = 'PlanNotFoundError'
  }
}

/** A plan that companies have is suspended, never deleted. */
export class PlanInUseError extends Error {
  constructor() {
    super('Companies are subscribed to this plan')
    this.name = 'PlanInUseError'
  }
}

const COLUMNS = {
  id: platformPlans.id,
  name: platformPlans.name,
  description: platformPlans.description,
  priceCents: platformPlans.priceCents,
  discount1: platformPlans.discount1,
  discount3: platformPlans.discount3,
  discount6: platformPlans.discount6,
  discount12: platformPlans.discount12,
  benefits: platformPlans.benefits,
  isActive: platformPlans.isActive,
}
type Row = { [K in keyof typeof COLUMNS]: (typeof COLUMNS)[K]['_']['data'] }

const columnsOf = (input: PlanInput) => ({
  name: input.name,
  description: input.description,
  priceCents: input.priceCents,
  discount1: input.discounts['1'],
  discount3: input.discounts['3'],
  discount6: input.discounts['6'],
  discount12: input.discounts['12'],
  benefits: input.benefits,
})

const toView = (row: Row, companies: number): PlanView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  priceCents: row.priceCents,
  discounts: { '1': row.discount1, '3': row.discount3, '6': row.discount6, '12': row.discount12 },
  benefits: row.benefits,
  isActive: row.isActive,
  companies,
})

/**
 * Vortomi's plans (console → Suscripciones → Planes, mockup web-34). Reached only through the
 * console's routes. A new price or discount reaches each subscribed company from its next invoice
 * (the billing reads the plan when it charges); nothing here rewrites what was already paid.
 */
export class PlatformPlanService {
  constructor(
    private readonly db: Database,
    private readonly subscribers: PlanSubscribers = noSubscribersYet,
  ) {}

  /** Oldest first, so the cards keep their place. */
  async list(): Promise<PlanView[]> {
    const rows = await this.db.select(COLUMNS).from(platformPlans).orderBy(asc(platformPlans.createdAt), asc(platformPlans.id))
    return this.withCompanies(rows)
  }

  async create(input: NewPlanInput): Promise<PlanView> {
    const [row] = await this.db
      .insert(platformPlans)
      .values({ ...columnsOf(input), isActive: input.isActive })
      .returning(COLUMNS)
    return toView(row!, 0)
  }

  /** Everything changes: name, description, price, discounts and benefits. */
  async update(id: string, input: PlanInput): Promise<PlanView> {
    const [row] = await this.db
      .update(platformPlans)
      .set({ ...columnsOf(input), updatedAt: sql`now()` })
      .where(eq(platformPlans.id, id))
      .returning(COLUMNS)
    if (!row) throw new PlanNotFoundError()
    return (await this.withCompanies([row]))[0]!
  }

  /** The switch: suspended hides the plan from everyone new; the companies on it keep it. */
  async setActive(id: string, isActive: boolean): Promise<PlanView> {
    const [row] = await this.db
      .update(platformPlans)
      .set({ isActive, updatedAt: sql`now()` })
      .where(eq(platformPlans.id, id))
      .returning(COLUMNS)
    if (!row) throw new PlanNotFoundError()
    return (await this.withCompanies([row]))[0]!
  }

  /** Only a plan no company has. */
  async remove(id: string): Promise<void> {
    const companies = (await this.subscribers.count([id])).get(id) ?? 0
    if (companies > 0) throw new PlanInUseError()
    const deleted = await this.db.delete(platformPlans).where(eq(platformPlans.id, id)).returning({ id: platformPlans.id })
    if (!deleted.length) throw new PlanNotFoundError()
  }

  private async withCompanies(rows: Row[]): Promise<PlanView[]> {
    const counts = await this.subscribers.count(rows.map((r) => r.id))
    return rows.map((row) => toView(row, counts.get(row.id) ?? 0))
  }
}

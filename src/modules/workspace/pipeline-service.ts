import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { contacts, pipelineStages } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import type { ContactService } from '../contacts/contact-service.ts'

export class StageNotFoundError extends Error {
  constructor() {
    super('Pipeline stage not found in this company')
    this.name = 'StageNotFoundError'
  }
}

export const stageInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})
export type StageInput = z.infer<typeof stageInput>

export const opportunityInput = z.object({
  stageId: z.uuid().nullable(),
  // Money in cents, never floats. Fits the integer column (20 million dollars).
  quoteCents: z.number().int().min(0).max(2_000_000_000).nullable(),
})
export type OpportunityInput = z.infer<typeof opportunityInput>

const columns = { id: pipelineStages.id, name: pipelineStages.name, color: pipelineStages.color, position: pipelineStages.position }

/** The company's sales stages and where each contact stands (v1: one opportunity per contact). */
export class PipelineService {
  constructor(private readonly contactService: ContactService) {}

  stages(scope: MemberScope) {
    return scope.tx
      .select(columns)
      .from(pipelineStages)
      .where(eq(pipelineStages.tenantId, scope.tenantId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.name))
  }

  /** New stages go last. */
  async create(scope: MemberScope, input: StageInput) {
    const [row] = await scope.tx
      .insert(pipelineStages)
      .values({
        tenantId: scope.tenantId,
        ...input,
        position: sql`(select coalesce(max(position) + 1, 0) from ${pipelineStages} where tenant_id = ${scope.tenantId})`,
      })
      .returning(columns)
    return row!
  }

  async update(scope: MemberScope, id: string, input: StageInput) {
    const [row] = await scope.tx
      .update(pipelineStages)
      .set(input)
      .where(and(eq(pipelineStages.tenantId, scope.tenantId), eq(pipelineStages.id, id)))
      .returning(columns)
    if (!row) throw new StageNotFoundError()
    return row
  }

  /** Deleting a stage that still holds contacts fails on contacts_stage_fk (409 stage_in_use). */
  async remove(scope: MemberScope, id: string) {
    const deleted = await scope.tx
      .delete(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, scope.tenantId), eq(pipelineStages.id, id)))
      .returning({ id: pipelineStages.id })
    if (!deleted.length) throw new StageNotFoundError()
  }

  /** `orderedIds` must be exactly the company's stages, in the new order. */
  async reorder(scope: MemberScope, orderedIds: string[]) {
    const current = await this.stages(scope)
    const same = current.length === orderedIds.length && new Set(orderedIds).size === orderedIds.length && current.every((s) => orderedIds.includes(s.id))
    if (!same) throw new StageNotFoundError()
    for (const [position, id] of orderedIds.entries()) {
      await scope.tx
        .update(pipelineStages)
        .set({ position })
        .where(and(eq(pipelineStages.tenantId, scope.tenantId), eq(pipelineStages.id, id)))
    }
    return this.stages(scope)
  }

  /** Moves a contact along the pipeline; the stage must be of this company. */
  async setOpportunity(scope: MemberScope, contactId: string, input: OpportunityInput) {
    await this.contactService.get(scope, contactId)
    if (input.stageId) {
      const [stage] = await scope.tx
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.tenantId, scope.tenantId), eq(pipelineStages.id, input.stageId)))
      if (!stage) throw new StageNotFoundError()
    }
    await scope.tx
      .update(contacts)
      .set({ stageId: input.stageId, quoteCents: input.quoteCents })
      .where(and(eq(contacts.tenantId, scope.tenantId), eq(contacts.id, contactId)))
  }
}

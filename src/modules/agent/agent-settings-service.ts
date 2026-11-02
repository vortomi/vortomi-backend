import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { AGENT_SCHEDULES, AGENT_TONES, type AgentSchedule, type AgentTone } from '../../db/schema/enums.ts'
import { agentSettings, agentUsage } from '../../db/schema/index.ts'
import type { MemberScope } from '../access/member-scope.ts'
import { monthOf } from './sales-agent.ts'

export const agentSettingsInput = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().min(1).max(40),
  tone: z.enum(AGENT_TONES),
  schedule: z.enum(AGENT_SCHEDULES),
  businessInfo: z.string().trim().max(4000),
})
export type AgentSettingsInput = z.infer<typeof agentSettingsInput>

/** What «Ajustes → Agente» shows. */
export interface AgentSettingsView {
  enabled: boolean
  assistantName: string
  tone: AgentTone
  schedule: AgentSchedule
  businessInfo: string
  /** False when the platform has no model configured: the agent cannot answer anywhere. */
  modelReady: boolean
  /** This month's answers against the monthly cap. */
  usage: { replies: number; cap: number }
}

const DEFAULTS = { enabled: false, assistantName: 'Asistente', tone: 'friendly', schedule: 'always', businessInfo: '' } as const

/** A company's sales agent settings. Admins only (the routes check it). */
export class AgentSettingsService {
  constructor(
    private readonly modelReady: boolean,
    private readonly monthlyCap: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(scope: MemberScope): Promise<AgentSettingsView> {
    const [row] = await scope.tx
      .select({ enabled: agentSettings.enabled, assistantName: agentSettings.assistantName, tone: agentSettings.tone, schedule: agentSettings.schedule, businessInfo: agentSettings.businessInfo })
      .from(agentSettings)
      .where(eq(agentSettings.tenantId, scope.tenantId))
    const [usage] = await scope.tx
      .select({ replies: agentUsage.replies })
      .from(agentUsage)
      .where(and(eq(agentUsage.tenantId, scope.tenantId), eq(agentUsage.month, monthOf(this.now()))))
    return { ...(row ?? DEFAULTS), modelReady: this.modelReady, usage: { replies: usage?.replies ?? 0, cap: this.monthlyCap } }
  }

  async save(scope: MemberScope, input: AgentSettingsInput): Promise<AgentSettingsView> {
    await scope.tx
      .insert(agentSettings)
      .values({ tenantId: scope.tenantId, ...input })
      .onConflictDoUpdate({ target: agentSettings.tenantId, set: { ...input, updatedAt: sql`now()` } })
    return this.view(scope)
  }
}

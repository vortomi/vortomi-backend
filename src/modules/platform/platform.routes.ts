import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { identityOf } from '../../http/authenticate.ts'
import { forbidden } from '../../http/errors.ts'
import { parseInput } from '../../http/validation.ts'
import type { AccessDirectory } from '../access/access-directory.ts'
import { type BusinessTypeService, newTypeInput, reclassifyInput } from '../setup/business-type-service.ts'
import { type UsageService, monthParam } from '../usage/usage-service.ts'
import { CompanyUsageService } from '../usage/company-usage.ts'
import { PlatformOverviewService, overviewQuery } from '../usage/platform-overview.ts'
import { type TenantAdminService, adminInvitationInput, channelInput, lookupInput, tenantInput, tenantStatusInput } from './tenant-admin-service.ts'
import { type ChannelAdminService, channelLookupInput, replaceNumberInput } from './channel-admin-service.ts'
import type { PlatformTeamService } from './platform-team-service.ts'
import { platformTeamRoutes } from './platform-team.routes.ts'
import { PlatformPaymentMethodService } from './platform-payment-methods.ts'
import { platformPaymentMethodRoutes } from './platform-payment-methods.routes.ts'
import { PlatformPlanService } from './platform-plans.ts'
import { platformPlanRoutes } from './platform-plans.routes.ts'
import { SubscriptionCounts, SubscriptionService } from '../subscriptions/subscription-service.ts'
import { platformSubscriptionRoutes } from '../subscriptions/subscription.routes.ts'
import { SubscriptionReviewService } from '../subscriptions/subscription-review-service.ts'
import { ExemptionService } from '../subscriptions/subscription-exemptions.ts'
import { SubscriptionSummaryService } from '../subscriptions/subscription-summary-service.ts'
import type { PaymentProofStore } from '../subscriptions/payment-proof-store.ts'
import { PlatformExchangeRateService } from './platform-exchange-rates.ts'
import { platformExchangeRateRoutes } from './platform-exchange-rates.routes.ts'
import type { BcvRateService } from '../exchange-rates/bcv-rate.service.ts'
import type { PlatformAlertService } from './platform-alert-service.ts'
import { TenantInsightService } from './tenant-insights.ts'
import { tenantInsightRoutes } from './tenant-insights.routes.ts'
import { trackConsoleActivity } from './console-activity.ts'
import type { CompanyPasswordResets } from '../password-reset/company-password-resets.ts'

export interface PlatformRoutesOptions {
  directory: AccessDirectory
  tenants: TenantAdminService
  db: Database
  usage: UsageService
  types: BusinessTypeService
  channels: ChannelAdminService
  team: PlatformTeamService
  alerts: PlatformAlertService
  /** Password links for a company's people, and handing a company to a new owner (mockup web-30). */
  resets: CompanyPasswordResets
  /** Agent answers per company and month (env AGENT_MONTHLY_REPLY_CAP), for the companies' figures. */
  agentCap?: number
  /** The platform's BCV reader, for Vortomi's own rate (Ajustes → Tasa de cambio). */
  bcv: Pick<BcvRateService, 'refresh'>
  /** The receipts of the payments companies make to Vortomi (Suscripciones → Pagos). */
  paymentProofs: PaymentProofStore | null
}

const tenantParams = z.object({ tenantId: z.uuid() })
const channelParams = z.object({ tenantId: z.uuid(), channelId: z.uuid() })
const invitationParams = tenantParams.extend({ invitationId: z.uuid() })
const memberParams = tenantParams.extend({ userId: z.uuid() })
const ownerBody = z.object({ userId: z.uuid() })
const sinceQuery = z.object({ since: z.iso.datetime({ offset: true }) })

/**
 * Platform console (our own team). Every route requires the super_admin role AND a
 * session signed in with the second factor (documentations/04, D12): this console
 * reaches every company, so a stolen password alone must not open it.
 */
export const platformRoutes: FastifyPluginCallback<PlatformRoutesOptions> = (app, { directory, tenants, db, usage, types, channels, team, alerts, resets, agentCap = 1000, bcv, paymentProofs }, done) => {
  app.addHook('preHandler', async (request) => {
    const identity = identityOf(request)
    const account = await directory.findAccount(identity.userId)
    if (account?.platformRole !== 'super_admin') throw forbidden('platform_admin_required')
    if (!identity.secondFactor) throw forbidden('second_factor_required')
  })
  // «Actividad en la consola» (mockup web-28): who changed what in which company.
  trackConsoleActivity(app, db, app.log)

  const id = (params: unknown) => parseInput(tenantParams, params).tenantId

  // Who enters this console: under the same guard as everything here.
  void app.register(platformTeamRoutes, { team })
  // The figures about each company (mockup web-25): same guard.
  void app.register(tenantInsightRoutes, { insights: new TenantInsightService(db, agentCap) })
  // Where companies pay Vortomi (Suscripciones → Métodos de pago): same guard.
  void app.register(platformPaymentMethodRoutes, { methods: new PlatformPaymentMethodService(db) })
  // Vortomi's plans (Suscripciones → Planes): same guard.
  void app.register(platformPlanRoutes, { plans: new PlatformPlanService(db, new SubscriptionCounts(db)) })
  // Each company's subscription and Suscripciones → Cobros (mockup web-37): same guard.
  const subscriptions = new SubscriptionService(db)
  void app.register(platformSubscriptionRoutes, {
    subscriptions,
    review: new SubscriptionReviewService(db, paymentProofs),
    exemptions: new ExemptionService(db),
    summary: new SubscriptionSummaryService(db, subscriptions),
  })
  // Vortomi's own exchange rate (Ajustes → Tasa de cambio): same guard.
  void app.register(platformExchangeRateRoutes, { rates: new PlatformExchangeRateService(db), bcv })

  app.get('/tenants', async () => ({ tenants: await tenants.list() }))

  // What companies wrote under «Otro», and turning it into types of the list.
  app.get('/business-types/unclassified', async () => ({ items: await types.unclassified() }))
  app.post('/business-types', async (request, reply) => {
    const { label, tenantIds } = parseInput(newTypeInput, request.body)
    return reply.code(201).send(await types.create(label, tenantIds))
  })
  app.post('/business-types/reclassify', (request) => {
    const { businessType, tenantIds } = parseInput(reclassifyInput, request.body)
    return types.reclassify(businessType, tenantIds)
  })
  app.post('/tenants', async (request, reply) => reply.code(201).send(await tenants.create(parseInput(tenantInput, request.body))))
  app.get('/tenants/:tenantId', (request) => tenants.detail(id(request.params)))
  app.put('/tenants/:tenantId', (request) => tenants.update(id(request.params), parseInput(tenantInput, request.body)))

  // A sign-up left half way and still empty; anything with data is refused (not_discardable).
  app.delete('/tenants/:tenantId', async (request, reply) => {
    await tenants.discardDraft(id(request.params))
    return reply.code(204).send()
  })

  app.put('/tenants/:tenantId/status', async (request, reply) => {
    await tenants.setStatus(id(request.params), parseInput(tenantStatusInput, request.body).status)
    return reply.code(204).send()
  })

  // POST, not GET: the account's token travels in the body, never in a URL that gets logged.
  app.post('/tenants/:tenantId/channels/lookup', (request) => {
    const input = parseInput(lookupInput, request.body)
    return tenants.lookupNumbers(id(request.params), input.wabaId, input.accessToken)
  })
  app.post('/tenants/:tenantId/channels', async (request, reply) =>
    reply.code(201).send(await tenants.connectChannel(id(request.params), parseInput(channelInput, request.body))),
  )

  // A number connected by mistake, or the company's real one instead of a test number: same place in
  // Vortomi, so its conversations stay; the stored token serves when none is typed (POST: no token in URLs).
  app.post('/tenants/:tenantId/channels/:channelId/lookup', (request) => {
    const { tenantId, channelId } = parseInput(channelParams, request.params)
    const input = parseInput(channelLookupInput, request.body)
    return channels.lookup(tenantId, channelId, input.wabaId, input.accessToken)
  })
  app.put('/tenants/:tenantId/channels/:channelId', (request) => {
    const { tenantId, channelId } = parseInput(channelParams, request.params)
    return channels.replace(tenantId, channelId, parseInput(replaceNumberInput, request.body))
  })
  app.post('/tenants/:tenantId/channels/:channelId/refresh', (request) => {
    const { tenantId, channelId } = parseInput(channelParams, request.params)
    return channels.refresh(tenantId, channelId)
  })

  app.get('/tenants/:tenantId/inbound', (request) =>
    tenants.lastInbound(id(request.params), new Date(parseInput(sinceQuery, request.query).since)),
  )

  app.post('/tenants/:tenantId/invitations', async (request, reply) =>
    reply.code(201).send(await tenants.inviteAdmin(id(request.params), parseInput(adminInvitationInput, request.body), identityOf(request).userId)),
  )
  // The owner connects the first number from their panel: invitation and «waiting for the owner» at once.
  app.post('/tenants/:tenantId/owner-invitation', async (request, reply) =>
    reply.code(201).send(await tenants.inviteOwner(id(request.params), parseInput(adminInvitationInput, request.body), identityOf(request).userId)),
  )
  app.post('/tenants/:tenantId/invitations/:invitationId/renew', (request) => {
    const params = parseInput(invitationParams, request.params)
    return tenants.renewInvitation(params.tenantId, params.invitationId)
  })
  app.delete('/tenants/:tenantId/invitations/:invitationId', async (request, reply) => {
    const params = parseInput(invitationParams, request.params)
    await tenants.revokeInvitation(params.tenantId, params.invitationId)
    return reply.code(204).send()
  })

  // Mockup web-30: a link for anyone of the company to choose a new password, and a new owner.
  app.post('/tenants/:tenantId/members/:userId/password-reset', async (request, reply) => {
    const { tenantId, userId } = parseInput(memberParams, request.params)
    return reply.code(201).send(await resets.issueAsConsole(identityOf(request).userId, tenantId, userId))
  })
  app.put('/tenants/:tenantId/owner', async (request, reply) => {
    await resets.transferOwner(id(request.params), parseInput(ownerBody, request.body).userId)
    return reply.code(204).send()
  })

  // Counts per company and number, never content: what billing and health need.
  // What our team must act on (mockup web-25): computed on each look, nothing stored.
  app.get('/alerts', () => alerts.report())
  app.get('/usage', async (request) => ({ items: await usage.monthly(db, parseInput(z.object({ month: monthParam }), request.query).month) }))
  // «Uso y salud» (mockups web-26 and web-27): every company's traffic, deliveries, agent and
  // health; and one company in detail. Counts only.
  app.get('/usage/overview', (request) => {
    const { from, to } = parseInput(overviewQuery, request.query)
    return new PlatformOverviewService().overview(db, from, to)
  })
  app.get('/usage/companies/:tenantId', (request) => {
    const { tenantId } = parseInput(tenantParams, request.params)
    const { from, to } = parseInput(overviewQuery, request.query)
    return new CompanyUsageService().usage(db, tenantId, from, to)
  })

  done()
}

import type { FastifyPluginAsync } from 'fastify'
import type { Database } from '../db/client.ts'
import { AccessDirectory } from '../modules/access/access-directory.ts'
import { accessRoutes } from '../modules/access/access.routes.ts'
import type { AccessTokenVerifier } from '../modules/access/identity.ts'
import type { ChannelCredentials } from '../modules/channels/channel-credentials.ts'
import { ContactService } from '../modules/contacts/contact-service.ts'
import { contactRoutes } from '../modules/contacts/contacts.routes.ts'
import { TagService } from '../modules/contacts/tag-service.ts'
import { ConversationCommands } from '../modules/conversations/conversation-commands.ts'
import { ConversationQueries } from '../modules/conversations/conversation-queries.ts'
import { conversationRoutes } from '../modules/conversations/conversations.routes.ts'
import { OutboundService } from '../modules/messaging/outbound.service.ts'
import { CategoryService } from '../modules/inventory/category-service.ts'
import { InventoryService } from '../modules/inventory/inventory-service.ts'
import { VariantTypeService } from '../modules/inventory/variant-type-service.ts'
import { inventoryRoutes } from '../modules/inventory/inventory.routes.ts'
import { UsageService } from '../modules/usage/usage-service.ts'
import { usageRoutes } from '../modules/usage/usage.routes.ts'
import { platformRoutes } from '../modules/platform/platform.routes.ts'
import { TenantAdminService } from '../modules/platform/tenant-admin-service.ts'
import { InvitationService } from '../modules/team/invitation-service.ts'
import { invitationRoutes, publicInvitationRoutes } from '../modules/team/invitation.routes.ts'
import { TeamService } from '../modules/team/team-service.ts'
import { teamRoutes } from '../modules/team/team.routes.ts'
import { PipelineService } from '../modules/workspace/pipeline-service.ts'
import { QuickReplyService } from '../modules/workspace/quick-reply-service.ts'
import { SettingsService } from '../modules/workspace/settings-service.ts'
import { workspaceRoutes } from '../modules/workspace/workspace.routes.ts'
import { TemplateService } from '../modules/templates/template-service.ts'
import { templateRoutes } from '../modules/templates/templates.routes.ts'
import type { BcvRateService } from '../modules/exchange-rates/bcv-rate.service.ts'
import { ExchangeRateService } from '../modules/exchange-rates/exchange-rate-service.ts'
import { exchangeRateRoutes } from '../modules/exchange-rates/exchange-rates.routes.ts'
import type { InboxFeed } from '../modules/realtime/inbox-feed.ts'
import { realtimeRoutes } from '../modules/realtime/realtime.routes.ts'
import { ReportService } from '../modules/reports/report-service.ts'
import { reportsRoutes } from '../modules/reports/reports.routes.ts'
import type { TemplateRegistry, WabaDirectory, WhatsAppSender } from '../modules/whatsapp/cloud-api.client.ts'
import { authenticate } from './authenticate.ts'
import { toApiError } from './domain-errors.ts'
import { installErrorHandler } from './errors.ts'

export interface ApiOptions {
  db: Database
  verifier: AccessTokenVerifier
  credentials: ChannelCredentials
  sender: WhatsAppSender
  templateRegistry: TemplateRegistry
  wabaDirectory: WabaDirectory
  feed: InboxFeed
  bcv: Pick<BcvRateService, 'refresh'>
}

const COMPANY = '/tenants/:tenantId'

/**
 * The few answers given without a session (/api/public): an invitation link shows who it is
 * for before the person has an account. Same error answers as the rest of the API.
 */
export const publicApiRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  installErrorHandler(app, toApiError)
  await app.register(publicInvitationRoutes, { invitations: new InvitationService(db) })
}

/**
 * The panel's API (/api). Everything in here requires a verified Supabase session;
 * company data is only reached through inCompany() (membership + withTenant).
 */
export const apiRoutes: FastifyPluginAsync<ApiOptions> = async (app, { db, verifier, credentials, sender, templateRegistry, wabaDirectory, feed, bcv }) => {
  installErrorHandler(app, toApiError)
  app.decorateRequest('identity', null)
  app.addHook('onRequest', authenticate(verifier))

  const directory = new AccessDirectory(db)
  const conversationQueries = new ConversationQueries()

  await app.register(accessRoutes, { db, directory })
  const usage = new UsageService()
  const invitations = new InvitationService(db)
  const tenantAdmin = new TenantAdminService(db, invitations, credentials, wabaDirectory)
  await app.register(platformRoutes, { prefix: '/platform', directory, tenants: tenantAdmin, db, usage })
  await app.register(usageRoutes, { prefix: COMPANY, db, usage })
  await app.register(conversationRoutes, {
    prefix: `${COMPANY}/conversations`,
    db,
    queries: conversationQueries,
    commands: new ConversationCommands(conversationQueries),
    outbound: new OutboundService(db, conversationQueries, credentials, sender),
  })
  const contactService = new ContactService()
  await app.register(contactRoutes, { prefix: COMPANY, db, contacts: contactService, tags: new TagService() })
  await app.register(templateRoutes, { prefix: COMPANY, db, templates: new TemplateService(db, credentials, templateRegistry) })
  const categories = new CategoryService()
  const variantTypes = new VariantTypeService()
  await app.register(inventoryRoutes, { prefix: COMPANY, db, inventory: new InventoryService(categories, variantTypes), categories, variantTypes })
  await app.register(realtimeRoutes, { prefix: COMPANY, db, feed })
  await app.register(reportsRoutes, { prefix: COMPANY, db, reports: new ReportService() })
  await app.register(exchangeRateRoutes, { prefix: COMPANY, db, rates: new ExchangeRateService(), bcv })
  await app.register(teamRoutes, { prefix: COMPANY, db, team: new TeamService(), invitations })
  await app.register(invitationRoutes, { invitations })
  await app.register(workspaceRoutes, {
    prefix: COMPANY,
    db,
    settings: new SettingsService(),
    quickReplies: new QuickReplyService(),
    pipeline: new PipelineService(contactService),
  })
}

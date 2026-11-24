import type { PaymentProofStore } from './modules/subscriptions/payment-proof-store.ts'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Database } from './db/client.ts'
import { apiRoutes, publicApiRoutes } from './http/api.ts'
import type { MediaStores } from './modules/chat-media/media-archiver.ts'
import type { AccessTokenVerifier } from './modules/access/identity.ts'
import type { ChannelCredentials } from './modules/channels/channel-credentials.ts'
import type { CatalogSources } from './modules/catalog-source/catalog-sources.ts'
import type { BcvRateService } from './modules/exchange-rates/bcv-rate.service.ts'
import type { InboxFeed } from './modules/realtime/inbox-feed.ts'
import type { TemplateRegistry, WabaDirectory, WhatsAppSender } from './modules/whatsapp/cloud-api.client.ts'
import { webhookRoutes } from './modules/whatsapp/webhook.routes.ts'
import type { BusinessTokenExchange } from './modules/whatsapp/meta-oauth.client.ts'
import type { SignupLaunch } from './modules/channels/channel-signup.routes.ts'
import type { AuthenticatorFactors } from './modules/platform/authenticator-factors.ts'
import { type AppSubscriptionWatch, watchingSubscriptions } from './modules/platform/app-subscription-watch.ts'
import { type StaffAccounts, SupabaseStaffAccounts } from './modules/platform/staff-accounts.ts'
import type { AccountPasswords } from './modules/password-reset/account-passwords.ts'
import { PasswordResetLinks } from './modules/password-reset/password-reset-links.ts'

export interface AppDependencies {
  db: Database
  verifyToken: string
  appSecrets: readonly string[]
  onVerifiedPayload: (payload: unknown) => Promise<void>
  tokenVerifier: AccessTokenVerifier
  credentials: ChannelCredentials
  sender: WhatsAppSender
  templateRegistry: TemplateRegistry
  wabaDirectory: WabaDirectory
  /** Inbox change notices for the panels' live streams. */
  feed: InboxFeed
  /** Reads the BCV for the companies that chose its rate. */
  bcv: Pick<BcvRateService, 'refresh'>
  /** Companies whose catalog lives in their own system (their rate, on the exchange-rate card). */
  catalogs?: Pick<CatalogSources, 'systemRate'>
  /** Whether the sales agent has a model, and its monthly cap per company (defaults: none, 1000). */
  agent?: { modelReady: boolean; monthlyCap: number }
  /** «Conectar WhatsApp» (Embedded Signup); without it the panel does not offer the button. */
  signup?: { exchange: BusinessTokenExchange; launch: SignupLaunch }
  /** Our console admins' authenticator codes (Supabase Auth); defaults to reading its schema directly. */
  authenticatorFactors?: AuthenticatorFactors
  /** Our staff's last access and devices (Supabase Auth); defaults to reading its schema directly. */
  staffAccounts?: StaffAccounts
  /** Sets passwords in Supabase Auth (secret key); without it password links answer reset_unavailable. */
  accountPasswords?: AccountPasswords | null
  /** Reads which apps receive each number's messages; unset: nothing watches them (tests). */
  appWatch?: Pick<AppSubscriptionWatch, 'wake'>
  /** Where the chat's files are kept (Cloudinary, Supabase Storage); unset: only on the phone. */
  mediaStores?: MediaStores
  /** Where the receipts of the payments to Vortomi are kept (private); unset: they cannot be sent. */
  paymentProofs?: PaymentProofStore | null
}

/** Secrets and signatures must never reach the logs. */
export const LOG_REDACT_PATHS = ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers.cookie']

/** Query parameters that carry a secret: Meta sends the verify token in the URL. */
const SECRET_QUERY_PARAMS = /([?&]hub[._]verify_token=)[^&]*/gi

/** The request URL as it may be logged: secrets in the query string replaced. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY_PARAMS, '$1[Redacted]')
}

/** HTTP surface only. Wiring of services lives in main.ts. */
export async function buildApp(deps: AppDependencies, logger: FastifyServerOptions['logger']): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Meta payloads are small; anything bigger is not for us.
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
  })

  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await deps.db.execute(sql`select 1`)
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' })
    }
  })

  await app.register(webhookRoutes, {
    prefix: '/webhooks/whatsapp',
    verifyToken: deps.verifyToken,
    appSecrets: deps.appSecrets,
    onVerifiedPayload: deps.onVerifiedPayload,
  })

  // Password links (mockup web-30): the public page uses them, the panel and the console give them.
  const resetLinks = new PasswordResetLinks(deps.db, deps.accountPasswords ?? null, deps.staffAccounts ?? new SupabaseStaffAccounts(deps.db))

  // Registered apart from /api so the session check there does not apply to it.
  await app.register(publicApiRoutes, { prefix: '/api/public', db: deps.db, resetLinks })

  await app.register(apiRoutes, {
    prefix: '/api',
    db: deps.db,
    verifier: deps.tokenVerifier,
    credentials: deps.credentials,
    sender: deps.sender,
    templateRegistry: deps.templateRegistry,
    // Each subscription of our app to an account has the numbers' apps read again (mockup web-31).
    wabaDirectory: deps.appWatch ? watchingSubscriptions(deps.wabaDirectory, deps.appWatch) : deps.wabaDirectory,
    feed: deps.feed,
    bcv: deps.bcv,
    ...(deps.catalogs ? { catalogs: deps.catalogs } : {}),
    agent: deps.agent ?? { modelReady: false, monthlyCap: 1000 },
    ...(deps.signup ? { signup: deps.signup } : {}),
    ...(deps.authenticatorFactors ? { authenticatorFactors: deps.authenticatorFactors } : {}),
    ...(deps.staffAccounts ? { staffAccounts: deps.staffAccounts } : {}),
    mediaStores: deps.mediaStores ?? { cloudinary: null, supabase: null },
    paymentProofs: deps.paymentProofs ?? null,
    resetLinks,
  })

  return app
}

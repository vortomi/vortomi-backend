import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Database } from './db/client.ts'
import { apiRoutes, publicApiRoutes } from './http/api.ts'
import type { AccessTokenVerifier } from './modules/access/identity.ts'
import type { ChannelCredentials } from './modules/channels/channel-credentials.ts'
import type { InboxFeed } from './modules/realtime/inbox-feed.ts'
import type { TemplateRegistry, WabaDirectory, WhatsAppSender } from './modules/whatsapp/cloud-api.client.ts'
import { webhookRoutes } from './modules/whatsapp/webhook.routes.ts'

export interface AppDependencies {
  db: Database
  verifyToken: string
  appSecret: string
  onVerifiedPayload: (payload: unknown) => Promise<void>
  tokenVerifier: AccessTokenVerifier
  credentials: ChannelCredentials
  sender: WhatsAppSender
  templateRegistry: TemplateRegistry
  wabaDirectory: WabaDirectory
  /** Inbox change notices for the panels' live streams. */
  feed: InboxFeed
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
    appSecret: deps.appSecret,
    onVerifiedPayload: deps.onVerifiedPayload,
  })

  // Registered apart from /api so the session check there does not apply to it.
  await app.register(publicApiRoutes, { prefix: '/api/public', db: deps.db })

  await app.register(apiRoutes, {
    prefix: '/api',
    db: deps.db,
    verifier: deps.tokenVerifier,
    credentials: deps.credentials,
    sender: deps.sender,
    templateRegistry: deps.templateRegistry,
    wabaDirectory: deps.wabaDirectory,
    feed: deps.feed,
  })

  return app
}

import { existsSync } from 'node:fs'
import { LOG_REDACT_PATHS, buildApp, redactUrl } from './app.ts'
import { loadEnv } from './config/env.ts'
import { createDatabase } from './db/client.ts'
import { SupabaseTokenVerifier } from './modules/access/supabase-token-verifier.ts'
import { ChannelCredentials } from './modules/channels/channel-credentials.ts'
import { CredentialCipher } from './modules/channels/credential-cipher.ts'
import { IngestService } from './modules/conversations/ingest.service.ts'
import { MessageStatusService } from './modules/conversations/message-status.service.ts'
import { EventRouter } from './modules/inbox/event-router.ts'
import { SerialQueue } from './modules/inbox/serial-queue.ts'
import { WebhookEventRepository } from './modules/inbox/webhook-event.repository.ts'
import { WebhookInbox } from './modules/inbox/webhook-inbox.ts'
import { WebhookProcessor } from './modules/inbox/webhook-processor.ts'
import { InboxFeed } from './modules/realtime/inbox-feed.ts'
import { ChannelDirectory } from './modules/tenancy/channel-directory.ts'
import { CloudApiClient } from './modules/whatsapp/cloud-api.client.ts'
import { TemplateService } from './modules/templates/template-service.ts'
import { parseWebhookPayload } from './modules/whatsapp/webhook-parser.ts'

const SWEEP_INTERVAL_MS = 60_000

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const env = loadEnv()
  const database = createDatabase(env.DATABASE_URL, env.DATABASE_POOL_MAX)
  const { db } = database

  const logger = {
    level: env.LOG_LEVEL,
    redact: LOG_REDACT_PATHS,
    serializers: {
      // Fastify's default request fields, with the URL cleaned of secrets.
      req: (request: { method: string; url: string; hostname?: string; ip?: string }) => ({
        method: request.method,
        url: redactUrl(request.url),
        hostname: request.hostname,
        remoteAddress: request.ip,
      }),
    },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  }

  const credentials = new ChannelCredentials(db, new CredentialCipher(env.CREDENTIALS_ENCRYPTION_KEY))
  const cloudApi = new CloudApiClient(env.GRAPH_API_VERSION)
  const feed = new InboxFeed()

  // The app is built first so the processing pipeline can share its logger.
  // The webhook callback only runs after listen(), when `inbox` exists.
  const app = await buildApp(
    {
      db,
      verifyToken: env.WEBHOOK_VERIFY_TOKEN,
      appSecret: env.META_APP_SECRET,
      tokenVerifier: new SupabaseTokenVerifier(env.SUPABASE_URL),
      credentials,
      sender: cloudApi,
      templateRegistry: cloudApi,
      wabaDirectory: cloudApi,
      feed,
      onVerifiedPayload: async (payload) => {
        await inbox.receive(payload)
      },
    },
    logger,
  )

  const repository = new WebhookEventRepository(db)
  const router = new EventRouter(
    db,
    new ChannelDirectory(db),
    new IngestService(),
    new MessageStatusService(),
    new TemplateService(db, credentials, cloudApi),
  )
  const processor = new WebhookProcessor(repository, parseWebhookPayload, router, app.log)
  const queue = new SerialQueue(
    (id) => processor.process(id),
    (id, error) => app.log.error({ webhookEventId: id, err: error }, 'Webhook processing crashed'),
  )
  const inbox = new WebhookInbox(repository, queue, { maxAttempts: 5, sweepGraceMs: 30_000, sweepBatchSize: 50 })

  // Recover whatever a previous run left unprocessed, then keep sweeping.
  const runSweep = () =>
    inbox.sweep().catch((error: unknown) => app.log.error({ err: error }, 'Webhook recovery sweep failed'))
  await runSweep()
  const sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS)
  // One LISTEN connection for the whole server; the panels' streams hang from it.
  const stopFeed = await feed.start(database.listen)

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'Shutting down')
    clearInterval(sweepTimer)
    await stopFeed()
    await app.close()
    await queue.idle()
    await database.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: env.HOST, port: env.PORT })
  app.log.info('Backend ready')
}

main().catch((error: unknown) => {
  // The logger may not exist yet; this is the only allowed console output.
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

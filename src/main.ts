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
import { BcvRateService } from './modules/exchange-rates/bcv-rate.service.ts'
import { HttpBcvSource } from './modules/exchange-rates/bcv-source.ts'
import { GeminiModel } from './modules/agent/gemini-model.ts'
import { SalesAgent } from './modules/agent/sales-agent.ts'
import { CatalogSources } from './modules/catalog-source/catalog-sources.ts'
import { CatalogCache } from './modules/catalog-source/external-catalog.ts'
import { CatalogSourceError } from './modules/catalog-source/lacampina-client.ts'
import { companyIsActive } from './modules/tenancy/company-status.ts'
import { AutoResponder } from './modules/messaging/auto-responder.ts'
import { ReceiptCollector } from './modules/orders/receipt-collector.ts'
import { AwayReplyService } from './modules/messaging/away-reply.ts'
import { BotDelivery } from './modules/messaging/bot-delivery.ts'
import { InboxFeed } from './modules/realtime/inbox-feed.ts'
import { ChannelDirectory } from './modules/tenancy/channel-directory.ts'
import { CloudApiClient } from './modules/whatsapp/cloud-api.client.ts'
import { TemplateService } from './modules/templates/template-service.ts'
import { parseWebhookPayload } from './modules/whatsapp/webhook-parser.ts'

const SWEEP_INTERVAL_MS = 60_000
/** The agent waits this long after a customer message: several quick messages get one answer. */
const AGENT_DEBOUNCE_MS = 4_000

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

  const cipher = new CredentialCipher(env.CREDENTIALS_ENCRYPTION_KEY)
  const credentials = new ChannelCredentials(db, cipher)
  const cloudApi = new CloudApiClient(env.GRAPH_API_VERSION)
  const feed = new InboxFeed()
  // Its logger is the app's: bound once the app exists (only used after listen()).
  const bcvLog = { warn: (message: string) => app.log.warn(message), error: (obj: object, message: string) => app.log.error(obj, message) }
  const bcv = new BcvRateService(db, new HttpBcvSource(bcvLog), bcvLog)
  // Companies whose catalog lives in their own system: read live, at most once per 90 s each.
  const catalogs = new CatalogSources(
    db,
    cipher,
    new CatalogCache({
      ttlMs: 90_000,
      staleMaxMs: 600_000,
      minRemaining: 10,
      onError: (tenantId, error) =>
        app.log.warn({ tenantId, reason: error instanceof CatalogSourceError ? error.message : error instanceof Error ? error.name : 'unknown' }, 'Company catalog could not be read'),
    }),
  )

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
      bcv,
      catalogs,
      agent: { modelReady: Boolean(env.GEMINI_API_KEY), monthlyCap: env.AGENT_MONTHLY_REPLY_CAP },
      onVerifiedPayload: async (payload) => {
        await inbox.receive(payload)
      },
    },
    logger,
  )

  // Automatic answers: the sales agent where its company keeps it on, else the away message.
  // Without a model key the agent stays off for every company.
  const delivery = new BotDelivery(db, credentials, cloudApi, cloudApi)
  const model = env.GEMINI_API_KEY ? new GeminiModel(env.GEMINI_API_KEY, env.AGENT_MODEL) : null
  const salesAgent = new SalesAgent(db, delivery, model, { monthlyCap: env.AGENT_MONTHLY_REPLY_CAP, debounceMs: AGENT_DEBOUNCE_MS, log: app.log, catalogs })
  const receipts = new ReceiptCollector(db, credentials, cloudApi, delivery, app.log)
  const autoResponder = new AutoResponder(salesAgent, new AwayReplyService(db, delivery, app.log), app.log, receipts, companyIsActive(db))

  const repository = new WebhookEventRepository(db)
  const router = new EventRouter(
    db,
    new ChannelDirectory(db),
    new IngestService(),
    new MessageStatusService(),
    new TemplateService(db, credentials, cloudApi),
    autoResponder,
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
  const stopBcv = bcv.start(env.BCV_CHECK_INTERVAL_MS)

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'Shutting down')
    clearInterval(sweepTimer)
    await stopFeed()
    await stopBcv()
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

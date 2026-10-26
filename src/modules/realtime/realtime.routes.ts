import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { inCompany } from '../../http/company-scope.ts'
import type { InboxFeed } from './inbox-feed.ts'

export interface RealtimeRoutesOptions {
  db: Database
  feed: InboxFeed
}

/** Keeps proxies from closing a quiet stream. */
const HEARTBEAT_MS = 25_000
/**
 * The stream ends on its own after this long; the panel reconnects with a fresh session token,
 * so a person removed from the company (or a suspended company) stops hearing within minutes.
 */
const STREAM_LIFETIME_MS = 10 * 60_000

/**
 * GET /tenants/:tenantId/events: a Server-Sent Events stream of inbox changes for one company.
 * Only ids travel here; the panel reads the content again through the API, under the same
 * visibility rules as always.
 */
export const realtimeRoutes: FastifyPluginCallback<RealtimeRoutesOptions> = (app, { db, feed }, done) => {
  // Open streams never go idle, so closing the server ends them itself instead of waiting.
  const open = new Set<() => void>()
  app.addHook('onClose', (_instance, next) => {
    for (const end of open) end()
    next()
  })

  app.get('/events', async (request, reply) => {
    // Membership first, like any other company route; the stream holds no transaction open.
    const tenantId = await inCompany(db, request, (scope) => Promise.resolve(scope.tenantId))

    reply.hijack()
    const stream = reply.raw
    stream.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    stream.write('retry: 3000\n\nevent: ready\ndata: {}\n\n')

    const unsubscribe = feed.subscribe(tenantId, (change) => {
      stream.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
    })
    const heartbeat = setInterval(() => stream.write(': ping\n\n'), HEARTBEAT_MS)
    const end = () => stream.end()
    const lifetime = setTimeout(end, STREAM_LIFETIME_MS)
    open.add(end)
    stream.on('close', () => {
      clearInterval(heartbeat)
      clearTimeout(lifetime)
      unsubscribe()
      open.delete(end)
    })
  })

  done()
}

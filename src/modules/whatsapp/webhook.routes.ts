import type { FastifyPluginCallback } from 'fastify'
import { safeEqual, verifyMetaSignature } from './signature.ts'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

export interface WebhookRoutesOptions {
  verifyToken: string
  appSecret: string
  /** Must persist the payload before resolving: Meta gets its 200 right after. */
  onVerifiedPayload: (payload: unknown) => Promise<void>
}

const verifyQuerySchema = {
  type: 'object',
  properties: {
    'hub.mode': { type: 'string' },
    'hub.verify_token': { type: 'string' },
    'hub.challenge': { type: 'string', maxLength: 256 },
  },
} as const

/**
 * Meta webhook endpoints. Registered as an encapsulated plugin so the raw-body
 * JSON parser below only applies to these routes.
 */
export const webhookRoutes: FastifyPluginCallback<WebhookRoutesOptions> = (app, options, done) => {
  // The signature is computed over the exact bytes received, so keep them.
  const parseJson = app.getDefaultJsonParser('error', 'error')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, parsed) => {
    const buffer = body as Buffer
    request.rawBody = buffer
    // The default parser is synchronous and reports through the callback.
    void parseJson(request, buffer.toString('utf8'), parsed)
  })

  // Subscription handshake: Meta calls it once when the webhook URL is saved.
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/',
    { schema: { querystring: verifyQuerySchema } },
    async (request, reply) => {
      const mode = request.query['hub.mode']
      const token = request.query['hub.verify_token']
      const challenge = request.query['hub.challenge']

      if (mode === 'subscribe' && token && challenge && safeEqual(token, options.verifyToken)) {
        return reply.code(200).type('text/plain').send(challenge)
      }
      return reply.code(403).send()
    },
  )

  app.post('/', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256']
    const header = Array.isArray(signature) ? undefined : signature

    // An unverified webhook would let anyone inject fake customer messages.
    if (!request.rawBody || !verifyMetaSignature(request.rawBody, header, options.appSecret)) {
      request.log.warn('Rejected webhook with a missing or invalid signature')
      return reply.code(401).send()
    }

    await options.onVerifiedPayload(request.body)
    return reply.code(200).send()
  })

  done()
}

import type { FastifyError, FastifyInstance } from 'fastify'

/**
 * An error meant for the client: a stable status and a machine code the panel
 * translates into Spanish. The message stays server-side; it never reaches the client.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 410 | 422,
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const unauthorized = (code = 'unauthorized') => new ApiError(401, code)
export const forbidden = (code = 'forbidden') => new ApiError(403, code)
export const notFound = (code = 'not_found') => new ApiError(404, code)

/**
 * One error shape for the whole API: `{ error: code }`. Known errors are translated
 * by `translate` (domain-errors.ts); anything unexpected is logged and answered with
 * a bare 500, so stack traces and SQL never leak.
 */
export function installErrorHandler(app: FastifyInstance, translate: (error: unknown) => ApiError | null): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const known = translate(error)
    if (known) return reply.code(known.statusCode).send({ error: known.code })
    // Fastify's own client errors (bad JSON, body too large, wrong content type).
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'bad_request' })
    }
    request.log.error({ err: error }, 'Unhandled API error')
    return reply.code(500).send({ error: 'internal' })
  })
}

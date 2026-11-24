import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import type { Database } from '../../db/client.ts'
import { type ConsoleAction, platformActivity, tenants } from '../../db/schema/index.ts'
import { identityOf } from '../../http/authenticate.ts'

type Resolve = ConsoleAction | ((body: unknown) => ConsoleAction | null)

const STATUS_ACTIONS: Record<string, ConsoleAction> = { active: 'tenant.activated', suspended: 'tenant.suspended', cancelled: 'tenant.cancelled' }

/**
 * The console's changes to companies, by route (relative to /platform). Lookups that only read
 * Meta (POST .../lookup) and the staff's own routes (their own history) are not listed.
 */
const ACTIONS: Record<string, Resolve> = {
  'POST /tenants': 'tenant.created',
  'PUT /tenants/:tenantId': 'tenant.updated',
  'DELETE /tenants/:tenantId': 'tenant.draft_discarded',
  'PUT /tenants/:tenantId/status': (body) => STATUS_ACTIONS[(body as { status?: string } | null)?.status ?? ''] ?? null,
  'POST /tenants/:tenantId/channels': 'channel.connected',
  'PUT /tenants/:tenantId/channels/:channelId': 'channel.replaced',
  'POST /tenants/:tenantId/channels/:channelId/refresh': 'channel.refreshed',
  'POST /tenants/:tenantId/invitations': 'tenant.admin_invited',
  'POST /tenants/:tenantId/owner-invitation': 'tenant.owner_invited',
  'POST /tenants/:tenantId/invitations/:invitationId/renew': 'tenant.invitation_renewed',
  'DELETE /tenants/:tenantId/invitations/:invitationId': 'tenant.invitation_revoked',
  'POST /tenants/:tenantId/members/:userId/password-reset': 'tenant.password_reset',
  'PUT /tenants/:tenantId/owner': 'tenant.owner_changed',
  'POST /tenants/:tenantId/subscription': 'subscription.plan_assigned',
  'POST /tenants/:tenantId/subscription-payments/:paymentId/approve': 'subscription.payment_approved',
  'POST /tenants/:tenantId/subscription-payments/:paymentId/reject': 'subscription.payment_rejected',
  'POST /business-types': 'business_type.created',
  'POST /business-types/reclassify': 'business_type.reclassified',
}

/** "POST /tenants/:tenantId", from the full route (/api/platform/tenants/:tenantId). */
function routeKey(request: FastifyRequest): string {
  const url = request.routeOptions.url ?? ''
  const at = url.indexOf('/platform/')
  return `${request.method} ${at < 0 ? url : url.slice(at + '/platform'.length)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The company in the URL, when it is a well-formed id; anything else the route itself refuses. */
const tenantIdOf = (value: unknown): string | null => {
  const id = (value as { tenantId?: unknown } | null)?.tenantId
  return typeof id === 'string' && UUID.test(id) ? id : null
}

/**
 * Records «Actividad en la consola» (mockup web-28) for every change that succeeded: who, what, which
 * company (named as it was: a discarded draft no longer exists after). Never what was typed. A
 * failure to record is logged and never fails the change itself.
 */
export function trackConsoleActivity(app: FastifyInstance, db: Database, log: Pick<FastifyBaseLogger, 'error'>): void {
  const before = new WeakMap<FastifyRequest, { tenantId: string | null; tenantName: string | null }>()

  app.addHook('preHandler', async (request) => {
    if (!ACTIONS[routeKey(request)]) return
    const tenantId = tenantIdOf(request.params)
    const [tenant] = tenantId ? await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)) : []
    before.set(request, { tenantId, tenantName: tenant?.name ?? null })
  })

  app.addHook('onSend', async (request, reply, payload) => {
    const resolve = ACTIONS[routeKey(request)]
    if (!resolve || reply.statusCode >= 300) return payload
    try {
      const action = typeof resolve === 'function' ? resolve(request.body) : resolve
      if (!action) return payload
      let target = before.get(request) ?? { tenantId: null, tenantName: null }
      // A new company: its id and name come in the answer.
      if (action === 'tenant.created' && typeof payload === 'string') {
        const created = JSON.parse(payload) as { id?: unknown; name?: unknown }
        target = { tenantId: typeof created.id === 'string' ? created.id : null, tenantName: typeof created.name === 'string' ? created.name : null }
      }
      await db.insert(platformActivity).values({ actorUserId: identityOf(request).userId, action, tenantId: target.tenantId, tenantName: target.tenantName?.slice(0, 200) ?? null })
    } catch (error) {
      log.error({ err: error }, 'Console activity could not be recorded')
    }
    return payload
  })
}

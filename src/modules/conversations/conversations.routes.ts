import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { CONVERSATION_STATUSES } from '../../db/schema/enums.ts'
import { companyOf, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { PAGE_SIZE, decodeCursor } from '../../shared/pagination.ts'
import type { OutboundService } from '../messaging/outbound.service.ts'
import { ConversationNotFoundError, type ConversationCommands } from './conversation-commands.ts'
import type { ConversationQueries } from './conversation-queries.ts'

export interface ConversationRoutesOptions {
  db: Database
  queries: ConversationQueries
  commands: ConversationCommands
  outbound: OutboundService
}

const limit = (fallback: number) => z.coerce.number().int().min(1).max(PAGE_SIZE.max).default(fallback)
const conversationParams = z.object({ conversationId: z.uuid() })

const listQuery = z.object({
  view: z.enum(['mine', 'unassigned', 'all']).default('all'),
  channelAccountId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  search: z.string().trim().min(1).max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: limit(PAGE_SIZE.default),
})
const messagesQuery = z.object({ beforeId: z.coerce.number().int().positive().optional(), limit: limit(50) })
const assignBody = z.object({ userId: z.uuid().nullable() })
const statusBody = z.object({ status: z.enum(CONVERSATION_STATUSES) })
// 4096 characters is the WhatsApp limit for a text message.
const sendBody = z.object({ body: z.string().trim().min(1).max(4096), clientMessageId: z.uuid() })
const templateMessageBody = z.object({
  templateId: z.uuid(),
  parameters: z.array(z.string().trim().min(1).max(1024)).max(20).default([]),
  clientMessageId: z.uuid(),
})
const noteBody = z.object({ body: z.string().trim().min(1).max(4000), mentionUserId: z.uuid().nullable().default(null) })

/** /tenants/:tenantId/conversations: the inbox. */
export const conversationRoutes: FastifyPluginCallback<ConversationRoutesOptions> = (app, { db, queries, commands, outbound }, done) => {
  app.get('/', (request) =>
    inCompany(db, request, (scope) => {
      const { cursor, ...filters } = parseInput(listQuery, request.query)
      return queries.list(scope, { ...filters, cursor: decodeCursor(cursor) })
    }),
  )

  app.get('/:conversationId', (request) =>
    inCompany(db, request, async (scope) => {
      const { conversationId } = parseInput(conversationParams, request.params)
      const conversation = await queries.get(scope, conversationId)
      if (!conversation) throw new ConversationNotFoundError()
      return conversation
    }),
  )

  app.get('/:conversationId/messages', (request) =>
    inCompany(db, request, async (scope) => {
      const { conversationId } = parseInput(conversationParams, request.params)
      const { beforeId, limit: size } = parseInput(messagesQuery, request.query)
      if (!(await queries.get(scope, conversationId))) throw new ConversationNotFoundError()
      return queries.messages(scope, conversationId, size, beforeId)
    }),
  )

  // Outside inCompany on purpose: the service opens its own short transactions so the
  // call to Meta never runs inside one (outbound.service.ts).
  app.post('/:conversationId/messages', async (request, reply) => {
    const { tenantId, userId } = companyOf(request)
    const { conversationId } = parseInput(conversationParams, request.params)
    const { body, clientMessageId } = parseInput(sendBody, request.body)
    const result = await outbound.sendText({ tenantId, userId, conversationId, body, clientMessageId })
    return reply.code(result.outcome === 'already_sent' ? 200 : 201).send(result)
  })

  // Templates: the only messages allowed once the 24 h window has closed.
  app.post('/:conversationId/template-messages', async (request, reply) => {
    const { tenantId, userId } = companyOf(request)
    const { conversationId } = parseInput(conversationParams, request.params)
    const { templateId, parameters, clientMessageId } = parseInput(templateMessageBody, request.body)
    const result = await outbound.sendTemplate({ tenantId, userId, conversationId, templateId, parameters, clientMessageId })
    return reply.code(result.outcome === 'already_sent' ? 200 : 201).send(result)
  })

  app.post('/:conversationId/read', async (request, reply) => {
    await inCompany(db, request, (scope) => commands.markRead(scope, parseInput(conversationParams, request.params).conversationId))
    return reply.code(204).send()
  })

  app.put('/:conversationId/assignee', async (request, reply) => {
    await inCompany(db, request, (scope) => {
      const { conversationId } = parseInput(conversationParams, request.params)
      return commands.assign(scope, conversationId, parseInput(assignBody, request.body).userId)
    })
    return reply.code(204).send()
  })

  app.put('/:conversationId/status', async (request, reply) => {
    await inCompany(db, request, (scope) => {
      const { conversationId } = parseInput(conversationParams, request.params)
      return commands.setStatus(scope, conversationId, parseInput(statusBody, request.body).status)
    })
    return reply.code(204).send()
  })

  app.get('/:conversationId/notes', (request) =>
    inCompany(db, request, async (scope) => ({
      items: await commands.notes(scope, parseInput(conversationParams, request.params).conversationId),
    })),
  )

  app.post('/:conversationId/notes', async (request, reply) => {
    const note = await inCompany(db, request, (scope) => {
      const { conversationId } = parseInput(conversationParams, request.params)
      const { body, mentionUserId } = parseInput(noteBody, request.body)
      return commands.addNote(scope, conversationId, body, mentionUserId)
    })
    return reply.code(201).send(note)
  })

  done()
}

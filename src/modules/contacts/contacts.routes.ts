import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { TAG_TONES } from '../../db/schema/enums.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { PAGE_SIZE, decodeCursor } from '../../shared/pagination.ts'
import { type ContactService, attributesInput, contactInput, importInput } from './contact-service.ts'
import type { TagService } from './tag-service.ts'

export interface ContactRoutesOptions {
  db: Database
  contacts: ContactService
  tags: TagService
}

const contactParams = z.object({ contactId: z.uuid() })
const tagParams = z.object({ tagId: z.uuid() })
const listQuery = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE.max).default(PAGE_SIZE.default),
})
const renameBody = z.object({ name: z.string().trim().min(1).max(80).nullable() })
const tagsBody = z.object({ tagIds: z.array(z.uuid()).max(20) })
const ownerBody = z.object({ ownerUserId: z.uuid().nullable() })
const attributesBody = z.object({ attributes: attributesInput })
const tagBody = z.object({ name: z.string().trim().min(1).max(40), tone: z.enum(TAG_TONES).default('neutral') })

/** /tenants/:tenantId/contacts and /tenants/:tenantId/tags. */
export const contactRoutes: FastifyPluginCallback<ContactRoutesOptions> = (app, { db, contacts, tags }, done) => {
  app.get('/contacts', (request) =>
    inCompany(db, request, (scope) => {
      const { cursor, ...filters } = parseInput(listQuery, request.query)
      return contacts.list(scope, { ...filters, cursor: decodeCursor(cursor) })
    }),
  )

  app.post('/contacts', async (request, reply) =>
    reply.code(201).send(await inCompany(db, request, (scope) => contacts.create(scope, parseInput(contactInput, request.body)))),
  )

  // A whole list at once is an admin's call.
  app.post('/contacts/import', (request) => asAdmin(db, request, (scope) => contacts.import(scope, parseInput(importInput, request.body))))

  app.get('/contacts/:contactId', (request) =>
    inCompany(db, request, (scope) => contacts.get(scope, parseInput(contactParams, request.params).contactId)),
  )

  app.put('/contacts/:contactId/name', async (request, reply) => {
    await inCompany(db, request, (scope) =>
      contacts.rename(scope, parseInput(contactParams, request.params).contactId, parseInput(renameBody, request.body).name),
    )
    return reply.code(204).send()
  })

  app.put('/contacts/:contactId/tags', async (request, reply) => {
    await inCompany(db, request, (scope) =>
      contacts.setTags(scope, parseInput(contactParams, request.params).contactId, parseInput(tagsBody, request.body).tagIds),
    )
    return reply.code(204).send()
  })

  app.put('/contacts/:contactId/owner', async (request, reply) => {
    await inCompany(db, request, (scope) =>
      contacts.setOwner(scope, parseInput(contactParams, request.params).contactId, parseInput(ownerBody, request.body).ownerUserId),
    )
    return reply.code(204).send()
  })

  app.put('/contacts/:contactId/attributes', async (request, reply) => {
    await inCompany(db, request, (scope) =>
      contacts.setAttributes(scope, parseInput(contactParams, request.params).contactId, parseInput(attributesBody, request.body).attributes),
    )
    return reply.code(204).send()
  })

  app.get('/tags',(request) => inCompany(db, request, async (scope) => ({ items: await tags.list(scope) })))

  app.post('/tags', async (request, reply) => {
    const tag = await asAdmin(db, request, (scope) => tags.create(scope, parseInput(tagBody, request.body)))
    return reply.code(201).send(tag)
  })

  app.put('/tags/:tagId', (request) =>
    asAdmin(db, request, (scope) => tags.update(scope, parseInput(tagParams, request.params).tagId, parseInput(tagBody, request.body))),
  )

  app.delete('/tags/:tagId', async (request, reply) => {
    await asAdmin(db, request, (scope) => tags.remove(scope, parseInput(tagParams, request.params).tagId))
    return reply.code(204).send()
  })

  done()
}

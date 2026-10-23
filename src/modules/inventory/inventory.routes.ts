import type { FastifyPluginCallback } from 'fastify'
import { z } from 'zod'
import type { Database } from '../../db/client.ts'
import { asAdmin, inCompany } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type CategoryService, categoryInput } from './category-service.ts'
import { type VariantTypeService, variantOptionInput, variantTypeInput } from './variant-type-service.ts'
import { type InventoryService, movementInput, productInput, productUpdate, variantInput, variantUpdate } from './inventory-service.ts'

export interface InventoryRoutesOptions {
  db: Database
  inventory: InventoryService
  categories: CategoryService
  variantTypes: VariantTypeService
}

const productParams = z.object({ productId: z.uuid() })
const categoryParams = z.object({ categoryId: z.uuid() })
const typeParams = z.object({ typeId: z.uuid() })
const optionParams = z.object({ optionId: z.uuid() })
const variantParams = z.object({ variantId: z.uuid() })
const activeBody = z.object({ active: z.boolean() })

/** /tenants/:tenantId/inventory. Everyone reads and sells; admins manage the catalog. */
export const inventoryRoutes: FastifyPluginCallback<InventoryRoutesOptions> = (app, { db, inventory, categories, variantTypes }, done) => {
  app.get('/inventory/variant-types', (request) => inCompany(db, request, async (scope) => ({ items: await variantTypes.list(scope) })))

  app.post('/inventory/variant-types', async (request, reply) =>
    reply.code(201).send(await asAdmin(db, request, (scope) => variantTypes.createType(scope, parseInput(variantTypeInput, request.body).name))),
  )

  app.put('/inventory/variant-types/:typeId', (request) =>
    asAdmin(db, request, (scope) => variantTypes.renameType(scope, parseInput(typeParams, request.params).typeId, parseInput(variantTypeInput, request.body).name)),
  )

  app.delete('/inventory/variant-types/:typeId', async (request, reply) => {
    await asAdmin(db, request, (scope) => variantTypes.removeType(scope, parseInput(typeParams, request.params).typeId))
    return reply.code(204).send()
  })

  app.post('/inventory/variant-types/:typeId/options', async (request, reply) =>
    reply
      .code(201)
      .send(
        await asAdmin(db, request, (scope) =>
          variantTypes.addOption(scope, parseInput(typeParams, request.params).typeId, parseInput(variantOptionInput, request.body).value),
        ),
      ),
  )

  app.put('/inventory/variant-options/:optionId', (request) =>
    asAdmin(db, request, (scope) =>
      variantTypes.renameOption(scope, parseInput(optionParams, request.params).optionId, parseInput(variantOptionInput, request.body).value),
    ),
  )

  app.delete('/inventory/variant-options/:optionId', async (request, reply) => {
    await asAdmin(db, request, (scope) => variantTypes.removeOption(scope, parseInput(optionParams, request.params).optionId))
    return reply.code(204).send()
  })

  app.get('/inventory/categories', (request) => inCompany(db, request, async (scope) => ({ items: await categories.list(scope) })))

  app.post('/inventory/categories', async (request, reply) =>
    reply.code(201).send(await asAdmin(db, request, (scope) => categories.create(scope, parseInput(categoryInput, request.body)))),
  )

  app.put('/inventory/categories/:categoryId', (request) =>
    asAdmin(db, request, (scope) => categories.update(scope, parseInput(categoryParams, request.params).categoryId, parseInput(categoryInput, request.body))),
  )

  app.delete('/inventory/categories/:categoryId', async (request, reply) => {
    await asAdmin(db, request, (scope) => categories.remove(scope, parseInput(categoryParams, request.params).categoryId))
    return reply.code(204).send()
  })

  app.get('/inventory/products', (request) => inCompany(db, request, async (scope) => ({ items: await inventory.list(scope) })))

  app.post('/inventory/products', async (request, reply) =>
    reply.code(201).send(await asAdmin(db, request, (scope) => inventory.create(scope, parseInput(productInput, request.body)))),
  )

  app.put('/inventory/products/:productId', async (request, reply) => {
    await asAdmin(db, request, (scope) =>
      inventory.updateProduct(scope, parseInput(productParams, request.params).productId, parseInput(productUpdate, request.body)),
    )
    return reply.code(204).send()
  })

  app.post('/inventory/products/:productId/variants', async (request, reply) =>
    reply
      .code(201)
      .send(await asAdmin(db, request, (scope) => inventory.addVariant(scope, parseInput(productParams, request.params).productId, parseInput(variantInput, request.body)))),
  )

  app.put('/inventory/products/:productId/active', async (request, reply) => {
    await asAdmin(db, request, (scope) =>
      inventory.setActive(scope, parseInput(productParams, request.params).productId, parseInput(activeBody, request.body).active),
    )
    return reply.code(204).send()
  })

  app.put('/inventory/variants/:variantId', (request) =>
    asAdmin(db, request, (scope) => inventory.updateVariant(scope, parseInput(variantParams, request.params).variantId, parseInput(variantUpdate, request.body))),
  )

  app.post('/inventory/variants/:variantId/movements', async (request, reply) =>
    reply
      .code(201)
      .send(await inCompany(db, request, (scope) => inventory.move(scope, parseInput(variantParams, request.params).variantId, parseInput(movementInput, request.body)))),
  )

  app.get('/inventory/variants/:variantId/movements', (request) =>
    inCompany(db, request, async (scope) => ({ items: await inventory.history(scope, parseInput(variantParams, request.params).variantId) })),
  )

  done()
}

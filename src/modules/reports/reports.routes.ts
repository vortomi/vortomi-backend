import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../../db/client.ts'
import { asAdmin } from '../../http/company-scope.ts'
import { parseInput } from '../../http/validation.ts'
import { type ReportService, reportRange } from './report-service.ts'

export interface ReportsRoutesOptions {
  db: Database
  reports: ReportService
}

/** /tenants/:tenantId/reports/days?from=YYYY-MM-DD&to=YYYY-MM-DD. Reports are for admins. */
export const reportsRoutes: FastifyPluginCallback<ReportsRoutesOptions> = (app, { db, reports }, done) => {
  app.get('/reports/days', (request) =>
    asAdmin(db, request, async (scope) => {
      const { from, to } = parseInput(reportRange, request.query)
      return { items: await reports.days(scope, from, to) }
    }),
  )
  done()
}

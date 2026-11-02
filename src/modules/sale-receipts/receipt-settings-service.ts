import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { RECEIPT_MODES, type ReceiptMode } from '../../db/schema/enums.ts'
import { mediaFiles, receiptSettings, tenants } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import { type PictureInput, pictureInput, readPicture } from './picture.ts'
import { receiptCode, suggestedFooter, suggestedPrefix } from './receipt-defaults.ts'

/** «Ajustes → Recibo». The prefix and the footer come prefilled, so the form always sends them. */
export const receiptSettingsInput = z.object({
  mode: z.enum(RECEIPT_MODES),
  subtitle: z.string().trim().max(60),
  phone: z.string().trim().max(30),
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/),
  footer: z.string().trim().max(300),
  showAttendedBy: z.boolean(),
  showPaymentReference: z.boolean(),
})
export type ReceiptSettingsInput = z.infer<typeof receiptSettingsInput>

/** PNG or JPEG up to 1 MB (the panel reads the file the person picks). */
export const MAX_LOGO_BYTES = 1024 * 1024
export const logoInput = pictureInput(MAX_LOGO_BYTES)

/** What the company printed on its receipts is, read-only here: it comes from its own profile. */
export interface ReceiptBusiness {
  name: string
  legalName: string
  taxId: string
  address: string
}

export interface ReceiptSettingsView extends ReceiptSettingsInput {
  hasLogo: boolean
  /** The code the next receipt will get: "APC-000001". */
  nextCode: string
  business: ReceiptBusiness
}

/** Everything a receipt is printed with. */
export interface ReceiptPrinting {
  settings: ReceiptSettingsView
  logo: { bytes: Buffer; mimeType: string } | null
  timezone: string
}

/** How each company gives its receipts. Writes are admins only (routes); taking a number is not. */
export class ReceiptSettingsService {
  async view(scope: TenantScope): Promise<ReceiptSettingsView> {
    return (await this.printing(scope, false)).settings
  }

  /** With the logo's bytes only when they are going to be drawn. */
  async printing(scope: TenantScope, withLogo = true): Promise<ReceiptPrinting> {
    const [row] = await scope.tx
      .select({
        name: tenants.name,
        legalName: tenants.legalName,
        taxId: tenants.taxId,
        address: tenants.fiscalAddress,
        businessType: tenants.businessType,
        timezone: tenants.timezone,
        settings: receiptSettings,
        logoId: mediaFiles.id,
        logo: withLogo ? { bytes: mediaFiles.content, mimeType: mediaFiles.mimeType } : sql<null>`null`,
      })
      .from(tenants)
      .leftJoin(receiptSettings, eq(receiptSettings.tenantId, tenants.id))
      .leftJoin(mediaFiles, and(eq(mediaFiles.tenantId, tenants.id), eq(mediaFiles.id, receiptSettings.logoMediaId)))
      .where(eq(tenants.id, scope.tenantId))
    if (!row) throw new Error('Company not found in its own scope')
    const s = row.settings
    const prefix = s?.prefix || suggestedPrefix(row.name)
    return {
      settings: {
        mode: s?.mode ?? 'vortomi',
        subtitle: s?.subtitle ?? '',
        phone: s?.phone ?? '',
        prefix,
        footer: s?.footer ?? suggestedFooter(row.businessType),
        showAttendedBy: s?.showAttendedBy ?? true,
        showPaymentReference: s?.showPaymentReference ?? true,
        hasLogo: row.logoId !== null,
        nextCode: receiptCode(prefix, s?.nextNumber ?? 1),
        business: { name: row.name, legalName: row.legalName, taxId: row.taxId, address: row.address },
      },
      logo: row.logo ?? null,
      timezone: row.timezone,
    }
  }

  async mode(scope: TenantScope): Promise<ReceiptMode> {
    const [row] = await scope.tx.select({ mode: receiptSettings.mode }).from(receiptSettings).where(eq(receiptSettings.tenantId, scope.tenantId))
    return row?.mode ?? 'vortomi'
  }

  async save(scope: TenantScope, input: ReceiptSettingsInput): Promise<ReceiptSettingsView> {
    await scope.tx
      .insert(receiptSettings)
      .values({ tenantId: scope.tenantId, ...input })
      .onConflictDoUpdate({ target: receiptSettings.tenantId, set: { ...input, updatedAt: sql`now()` } })
    return this.view(scope)
  }

  async setLogo(scope: TenantScope, input: PictureInput): Promise<ReceiptSettingsView> {
    const { bytes, mimeType } = readPicture(input, MAX_LOGO_BYTES)
    const [file] = await scope.tx
      .insert(mediaFiles)
      .values({ tenantId: scope.tenantId, mimeType, sizeBytes: bytes.length, content: bytes })
      .returning({ id: mediaFiles.id })
    await this.setLogoId(scope, file!.id)
    return this.view(scope)
  }

  async clearLogo(scope: TenantScope): Promise<ReceiptSettingsView> {
    await this.setLogoId(scope, null)
    return this.view(scope)
  }

  /**
   * The next number, taken for the receipt being issued in this same transaction: the row stays
   * locked until it commits, so two receipts never share a number, and one rolled back frees it.
   */
  async takeNumber(scope: TenantScope): Promise<number> {
    await scope.tx.insert(receiptSettings).values({ tenantId: scope.tenantId }).onConflictDoNothing()
    const [row] = await scope.tx
      .update(receiptSettings)
      .set({ nextNumber: sql`${receiptSettings.nextNumber} + 1` })
      .where(eq(receiptSettings.tenantId, scope.tenantId))
      .returning({ next: receiptSettings.nextNumber })
    return row!.next - 1
  }

  private async setLogoId(scope: TenantScope, logoMediaId: string | null): Promise<void> {
    await scope.tx
      .insert(receiptSettings)
      .values({ tenantId: scope.tenantId, logoMediaId })
      .onConflictDoUpdate({ target: receiptSettings.tenantId, set: { logoMediaId, updatedAt: sql`now()` } })
  }
}

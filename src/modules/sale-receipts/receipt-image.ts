import { createRequire } from 'node:module'
import { Resvg } from '@resvg/resvg-js'
import { DECIMAL_SALE_UNITS, type Fulfillment, type SaleUnit } from '../../db/schema/enums.ts'
import { lineCents } from '../orders/order-quote.ts'

// The sale receipt as a picture: one layout for every company, filled with its own data, drawn as
// SVG and turned into a PNG the customer sees right in WhatsApp. The font travels with the code
// (Roboto Mono, OFL), so it looks the same on any server, with or without fonts installed.

export interface ReceiptLine {
  name: string
  quantity: number
  saleUnit: SaleUnit
  unitPriceCents: number
}

/** Everything printed on one receipt. */
export interface ReceiptData {
  business: { name: string; subtitle: string; legalName: string; taxId: string; address: string; phone: string }
  logo: { bytes: Buffer; mimeType: string } | null
  /** "APC-000050". */
  code: string
  issuedAt: Date
  timezone: string
  attendedBy: string | null
  customerName: string
  lines: ReceiptLine[]
  fulfillment: Fulfillment
  /** Null: delivery whose cost was still to be confirmed. */
  deliveryCents: number | null
  bsPerUsd: string | null
  paymentMethod: string | null
  paymentReference: string | null
  footer: string
}

export const DISCLAIMER = 'Este documento es un comprobante informativo de la venta y no constituye una factura fiscal.'

const require = createRequire(import.meta.url)
const FONT_FILES = ['400Regular/RobotoMono_400Regular.ttf', '700Bold/RobotoMono_700Bold.ttf'].map((file) => require.resolve(`@expo-google-fonts/roboto-mono/${file}`))

const WIDTH = 600
const PAD = 32
const RIGHT = WIDTH - PAD
/** Roboto Mono: every character is 0.6 of the font size wide. */
const charsFor = (size: number) => Math.floor((WIDTH - 2 * PAD) / (size * 0.6))
const BODY = 15
const SMALL = 12.5
const INK = '#111111'
const MUTED = '#666666'
/** Table columns, by where each one ends (in characters of the body size). */
const COLUMN_END = { quantity: 35, unitPrice: 47 }
const DESCRIPTION_CHARS = 24

const number = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const quantityNumber = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 })
const UNIT_SHORT: Partial<Record<SaleUnit, string>> = { kg: 'kg', m: 'm', m2: 'm²', l: 'L', hour: 'h' }

const usd = (cents: number) => `$${number.format(cents / 100)}`
const bs = (cents: number, rate: string) => `Bs ${number.format(Math.round((cents / 100) * Number(rate) * 100) / 100)}`
const quantityText = (line: ReceiptLine) =>
  DECIMAL_SALE_UNITS.includes(line.saleUnit) ? `${quantityNumber.format(line.quantity)} ${UNIT_SHORT[line.saleUnit] ?? ''}`.trim() : quantityNumber.format(line.quantity)

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Words in lines of at most `width` characters; a longer word is cut. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    for (let piece = word; piece; piece = piece.slice(width)) {
      const chunk = piece.slice(0, width)
      if (!current) current = chunk
      else if (current.length + 1 + chunk.length <= width) current += ` ${chunk}`
      else {
        lines.push(current)
        current = chunk
      }
    }
  }
  if (current) lines.push(current)
  return lines
}

interface TextStyle {
  anchor?: 'start' | 'middle' | 'end'
  bold?: boolean
  size?: number
  muted?: boolean
  /** Rows only: the label in bold too (the total). */
  boldLabel?: boolean
}

/** Draws top to bottom, keeping the height it reached. */
class Sheet {
  private readonly parts: string[] = []
  y = PAD

  text(x: number, content: string, { anchor = 'start', bold = false, size = BODY, muted = false }: TextStyle = {}): void {
    this.parts.push(
      `<text x="${x}" y="${this.y}" font-size="${size}" text-anchor="${anchor}"${bold ? ' font-weight="700"' : ''} fill="${muted ? MUTED : INK}">${escape(content)}</text>`,
    )
  }

  line(size = BODY): void {
    this.y += Math.round(size * 1.6)
  }

  centered(content: string, style: TextStyle = {}): void {
    const size = style.size ?? BODY
    for (const part of wrap(content, charsFor(size))) {
      this.line(size)
      this.text(WIDTH / 2, part, { ...style, anchor: 'middle' })
    }
  }

  /** "Label:" on the left and its value on the right (wrapped under it when long). */
  row(label: string, value: string, style: TextStyle = {}): void {
    const size = style.size ?? BODY
    const room = charsFor(size) - label.length - 2
    const parts = wrap(value, room)
    this.line(size)
    this.text(PAD, label, { size, muted: style.muted, bold: style.boldLabel })
    parts.forEach((part, i) => {
      if (i > 0) this.line(size)
      this.text(RIGHT, part, { ...style, anchor: 'end' })
    })
  }

  separator(): void {
    this.y += 14
    this.parts.push(`<line x1="${PAD}" y1="${this.y}" x2="${RIGHT}" y2="${this.y}" stroke="${INK}" stroke-width="1.2" stroke-dasharray="6 4"/>`)
    this.y += 4
  }

  image(logo: NonNullable<ReceiptData['logo']>): void {
    const height = 72
    this.parts.push(
      `<image x="${PAD}" y="${this.y}" width="${WIDTH - 2 * PAD}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:${logo.mimeType};base64,${logo.bytes.toString('base64')}"/>`,
    )
    this.y += height + 4
  }

  svg(): string {
    const height = this.y + PAD
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Roboto Mono">`,
      `<rect width="100%" height="100%" fill="#ffffff"/>`,
      ...this.parts,
      '</svg>',
    ].join('\n')
  }
}

/** The receipt as SVG: the business, the sale, its totals, how it was paid and the company's words. */
export function receiptSvg(data: ReceiptData): string {
  const sheet = new Sheet()
  const { business } = data
  if (data.logo) sheet.image(data.logo)
  sheet.centered(business.name.toUpperCase(), { bold: true, size: 20 })
  if (business.subtitle) sheet.centered(business.subtitle)
  if (business.legalName && business.legalName.toLowerCase() !== business.name.toLowerCase()) sheet.centered(business.legalName, { size: SMALL, muted: true })
  if (business.taxId) sheet.centered(`RIF ${business.taxId}`, { size: SMALL, muted: true })
  if (business.address) sheet.centered(business.address, { size: SMALL, muted: true })
  if (business.phone) sheet.centered(`Tel. ${business.phone}`, { size: SMALL, muted: true })

  sheet.separator()
  const day = new Intl.DateTimeFormat('es-VE', { timeZone: data.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(data.issuedAt)
  const time = new Intl.DateTimeFormat('es-VE', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: true }).format(data.issuedAt)
  sheet.row('N° Recibo:', data.code, { bold: true })
  sheet.row('Fecha:', day)
  sheet.row('Hora:', time)
  if (data.attendedBy) sheet.row('Atendido por:', data.attendedBy)
  sheet.row('Cliente:', data.customerName)

  sheet.separator()
  sheet.line()
  const at = (column: number) => PAD + column * BODY * 0.6
  sheet.text(PAD, 'DESCRIPCIÓN', { bold: true })
  sheet.text(at(COLUMN_END.quantity), 'CANT', { bold: true, anchor: 'end' })
  sheet.text(at(COLUMN_END.unitPrice), 'P.UNIT', { bold: true, anchor: 'end' })
  sheet.text(RIGHT, 'TOTAL', { bold: true, anchor: 'end' })
  for (const line of data.lines) {
    wrap(line.name, DESCRIPTION_CHARS).forEach((part, i) => {
      sheet.line()
      sheet.text(PAD, part)
      if (i > 0) return
      sheet.text(at(COLUMN_END.quantity), quantityText(line), { anchor: 'end' })
      sheet.text(at(COLUMN_END.unitPrice), usd(line.unitPriceCents), { anchor: 'end' })
      sheet.text(RIGHT, usd(lineCents(line)), { anchor: 'end' })
    })
  }

  sheet.separator()
  const subtotal = data.lines.reduce((sum, l) => sum + lineCents(l), 0)
  const total = subtotal + (data.deliveryCents ?? 0)
  sheet.row('Subtotal:', usd(subtotal))
  if (data.fulfillment === 'delivery') sheet.row('Envío:', data.deliveryCents === null ? 'Por confirmar' : usd(data.deliveryCents))
  sheet.y += 6
  sheet.row('TOTAL:', `${usd(total)} USD`, { bold: true, boldLabel: true, size: 20 })
  if (data.bsPerUsd) {
    sheet.row('Equivalente:', bs(total, data.bsPerUsd), { muted: true })
    sheet.row('Tasa:', `${number.format(Number(data.bsPerUsd))} Bs/USD`, { size: SMALL, muted: true })
  }

  if (data.paymentMethod || data.paymentReference) {
    sheet.separator()
    if (data.paymentMethod) sheet.row('Método de pago:', data.paymentMethod, { bold: true })
    if (data.paymentReference) sheet.row('Referencia:', data.paymentReference)
  }

  sheet.separator()
  if (data.footer.trim()) {
    sheet.y += 4
    sheet.centered(data.footer)
  }
  sheet.y += 6
  sheet.centered(DISCLAIMER, { size: SMALL, muted: true })
  return sheet.svg()
}

/** The receipt as PNG, twice the drawing's size so it reads sharp on a phone. */
export function renderReceipt(data: ReceiptData): Buffer {
  const svg = receiptSvg(data)
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH * 2 },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Roboto Mono' },
  })
  return resvg.render().asPng()
}

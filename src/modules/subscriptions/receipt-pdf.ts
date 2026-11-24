import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, degrees, rgb, setCharacterSpacing } from 'pdf-lib'
import type { ReceiptSnapshot } from '../../db/schema/subscription-ledger.ts'
import { VORTOMI_LOGO_PNG } from './vortomi-logo.ts'

// The receipt of a payment to Vortomi as a PDF (design A of mockup web-42, logo of web-48): white,
// a header with the logo, who paid and how in two columns, the period's line, the totals and a
// stamp. Letter size. The standard PDF fonts carry the Spanish letters (Windows-1252); anything
// outside that set is replaced before it is written.

const PAGE = { width: 612, height: 792 }
const MARGIN = 48
const INK = rgb(0.067, 0.094, 0.153)
const MUTED = rgb(0.42, 0.447, 0.502)
const SOFT = rgb(0.898, 0.906, 0.922)
const GREEN = rgb(0.02, 0.588, 0.412)
const AMBER = rgb(0.851, 0.467, 0.024)
const FROM = [0x00, 0xc6, 0xe0]
const TO = [0x3d, 0x5b, 0xff]

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** Characters the standard fonts lack, in a form they have (codes, so no invisible character sits in the source). */
const ch = (...codes: number[]) => codes.map((c) => String.fromCharCode(c)).join('')
const DASHES = new RegExp(`[${ch(0x2212, 0x2010, 0x2011)}]`, 'g')
const ARROW = new RegExp(ch(0x2192), 'g')
const SPACES = new RegExp(`[${ch(0x00a0, 0x202f)}]`, 'g')
// Printable ASCII, Latin-1 letters and the few Windows-1252 marks used here (dashes, quotes, bullet, ellipsis, euro, middle dot).
const OUTSIDE = new RegExp(`[^${ch(0x20)}-${ch(0x7e)}${ch(0xa1)}-${ch(0xff)}${ch(0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac)}]`, 'g')
const winAnsi = (text: string) => text.replace(DASHES, '-').replace(ARROW, '>').replace(SPACES, ' ').replace(OUTSIDE, '')

const money = (cents: number) => `${new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} $`
const amount = (value: string, currency: 'USD' | 'VES') =>
  `${new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${currency === 'VES' ? 'Bs' : '$'}`
const rate = (value: string) => `${new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} Bs/$`
const short = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
const long = (day: string) => `${Number(day.slice(8, 10))} de ${MONTHS[Number(day.slice(5, 7)) - 1]} de ${day.slice(0, 4)}`

/** «VTM-000001». */
export const receiptCode = (number: number) => `VTM-${String(number).padStart(6, '0')}`

interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

/** Text that fits `width`, cut with «…» when it does not. */
function fit(font: PDFFont, size: number, text: string, width: number): string {
  let t = winAnsi(text)
  if (font.widthOfTextAtSize(t, size) <= width) return t
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1)
  return `${t}…`
}

/** Words wrapped to `width`, at most `lines` lines. */
function wrap(font: PDFFont, size: number, text: string, width: number, lines: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= width) line = next
    else {
      if (line) out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  if (out.length > lines) out.splice(lines - 1, out.length, fit(font, size, out.slice(lines - 1).join(' '), width))
  return out
}

function text(page: PDFPage, value: string, x: number, y: number, font: PDFFont, size: number, color = INK): void {
  page.drawText(winAnsi(value), { x, y, size, font, color })
}

function right(page: PDFPage, value: string, xRight: number, y: number, font: PDFFont, size: number, color = INK): void {
  const t = winAnsi(value)
  page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color })
}

/** Letter-spaced capitals, ending at `xRight` («RECIBO DE PAGO»). */
function spaced(page: PDFPage, value: string, xRight: number, y: number, font: PDFFont, size: number, spacing: number): void {
  const t = winAnsi(value)
  const width = font.widthOfTextAtSize(t, size) + spacing * (t.length - 1)
  page.pushOperators(setCharacterSpacing(spacing))
  page.drawText(t, { x: xRight - width, y, size, font, color: INK })
  page.pushOperators(setCharacterSpacing(0))
}

/** The brand's gradient as a thin bar. */
function gradientBar(page: PDFPage, x: number, y: number, width: number, height: number): void {
  const steps = 80
  for (let i = 0; i < steps; i++) {
    const k = i / (steps - 1)
    const [r, g, b] = FROM.map((c, j) => (c + (TO[j]! - c) * k) / 255) as [number, number, number]
    page.drawRectangle({ x: x + (width / steps) * i, y, width: width / steps + 0.4, height, color: rgb(r, g, b) })
  }
}

function label(page: PDFPage, value: string, x: number, y: number, fonts: Fonts): void {
  page.pushOperators(setCharacterSpacing(0.8))
  page.drawText(winAnsi(value.toUpperCase()), { x, y, size: 7.5, font: fonts.bold, color: MUTED })
  page.pushOperators(setCharacterSpacing(0))
}

/** The receipt of one approved payment, as PDF bytes. */
export async function receiptPdf(number: number, issuedAt: Date, r: ReceiptSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Recibo ${receiptCode(number)} · Vortomi`)
  doc.setAuthor('Vortomi')
  doc.setCreator('Vortomi')
  doc.setProducer('Vortomi')
  doc.setCreationDate(issuedAt)
  const page = doc.addPage([PAGE.width, PAGE.height])
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) }
  const { regular, bold } = fonts
  const left = MARGIN
  const end = PAGE.width - MARGIN
  const issued = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(issuedAt)

  // Header: the logo, and the document's name, number and date.
  const logo = await doc.embedPng(VORTOMI_LOGO_PNG)
  const logoHeight = 34
  let y = PAGE.height - MARGIN - logoHeight
  page.drawImage(logo, { x: left, y, width: (logo.width / logo.height) * logoHeight, height: logoHeight })
  spaced(page, 'RECIBO DE PAGO', end, y + 22, bold, 14, 2.2)
  right(page, `N.º ${receiptCode(number)}`, end, y + 9, regular, 9.5, MUTED)
  right(page, `Emitido el ${long(issued)}`, end, y - 3, regular, 9.5, MUTED)
  y -= 22
  gradientBar(page, left, y, end - left, 3)

  // Who paid, and how.
  y -= 28
  const col = left + (end - left) / 2 + 14
  label(page, 'Recibido de', left, y, fonts)
  label(page, 'Forma de pago', col, y, fonts)
  let ly = y - 16
  for (const line of wrap(bold, 11.5, r.company.legalName || r.company.name, col - left - 24, 2)) {
    text(page, line, left, ly, bold, 11.5)
    ly -= 14
  }
  if (r.company.taxId) {
    text(page, `RIF ${r.company.taxId}`, left, ly, regular, 9.5, rgb(0.216, 0.255, 0.318))
    ly -= 13
  }
  for (const line of wrap(regular, 9.5, r.company.address ?? '', col - left - 24, 3)) {
    text(page, line, left, ly, regular, 9.5, rgb(0.216, 0.255, 0.318))
    ly -= 12.5
  }
  const pay: [string, string][] = [
    ['Método', r.method],
    ...(r.reference ? ([['Referencia', r.reference]] as [string, string][]) : []),
    ['Fecha del pago', short(r.paidOn)],
    ['Monto', amount(r.amount, r.currency)],
    ...(r.currency === 'VES' && r.bsPerUsd ? ([['Tasa Vortomi', rate(r.bsPerUsd)]] as [string, string][]) : []),
  ]
  let ry = y - 16
  for (const [key, value] of pay) {
    text(page, key, col, ry, regular, 9.5, MUTED)
    right(page, fit(bold, 9.5, value, end - col - 80), end, ry, bold, 9.5)
    ry -= 14
  }
  y = Math.min(ly, ry) - 18

  // The period's line.
  const cols = { concept: left, period: left + 168, months: left + 300, price: left + 352, discount: left + 404, total: end }
  page.drawLine({ start: { x: left, y: y - 6 }, end: { x: end, y: y - 6 }, thickness: 1.2, color: INK })
  label(page, 'Concepto', cols.concept, y, fonts)
  label(page, 'Período', cols.period, y, fonts)
  right(page, 'MESES', cols.months + 22, y, bold, 7.5, MUTED)
  right(page, 'PRECIO', cols.price + 40, y, bold, 7.5, MUTED)
  right(page, 'DESC.', cols.discount + 28, y, bold, 7.5, MUTED)
  right(page, 'IMPORTE', cols.total, y, bold, 7.5, MUTED)
  y -= 24
  text(page, fit(bold, 10, `Plan ${r.plan}`, 160), cols.concept, y, bold, 10)
  text(page, 'Suscripción mensual a Vortomi', cols.concept, y - 12, regular, 8.5, MUTED)
  text(page, r.period ? `${short(r.period.from)} – ${short(r.period.to)}` : 'Saldo a favor', cols.period, y, regular, 10)
  right(page, String(r.months), cols.months + 22, y, regular, 10)
  right(page, money(r.basePriceCents), cols.price + 40, y, regular, 10)
  right(page, `${r.discountPercent} %`, cols.discount + 28, y, regular, 10)
  right(page, money(r.chargeCents), cols.total, y, regular, 10)
  y -= 24
  page.drawLine({ start: { x: left, y }, end: { x: end, y }, thickness: 0.8, color: SOFT })

  // Totals on the right; the stamp and the notes on the left.
  const tx = end - 230
  let ty = y - 22
  const subtotal = r.basePriceCents * r.months
  const totals: [string, string, boolean][] = [
    ['Subtotal', money(subtotal), false],
    ...(subtotal > r.chargeCents ? ([[`Descuento ${r.months} ${r.months === 1 ? 'mes' : 'meses'} (${r.discountPercent} %)`, `-${money(subtotal - r.chargeCents)}`, false]] as [string, string, boolean][]) : []),
    ['Total del período', money(r.chargeCents), false],
    ...(r.paidBeforeCents > 0 ? ([['Pagado antes', `-${money(r.paidBeforeCents)}`, false]] as [string, string, boolean][]) : []),
  ]
  for (const [key, value] of totals) {
    text(page, key, tx, ty, regular, 9.5, MUTED)
    right(page, value, end, ty, regular, 9.5)
    ty -= 15
  }
  page.drawLine({ start: { x: tx, y: ty + 6 }, end: { x: end, y: ty + 6 }, thickness: 1.2, color: INK })
  ty -= 12
  text(page, 'Total pagado', tx, ty, bold, 10.5)
  right(page, money(r.receivedCents), end, ty - 1, bold, 15)
  ty -= 18
  const after: [string, string][] = [
    ...(r.excessCents > 0 ? ([['A su saldo a favor', money(r.excessCents)]] as [string, string][]) : []),
    ...(r.pendingCents > 0 ? ([['Saldo pendiente', money(r.pendingCents)]] as [string, string][]) : []),
  ]
  for (const [key, value] of after) {
    text(page, key, tx, ty, regular, 9.5, MUTED)
    right(page, value, end, ty, regular, 9.5)
    ty -= 15
  }

  // The stamp: PAGADO when the period is paid, ABONO when part of it is still owed.
  const paid = r.pendingCents === 0
  const stamp = paid ? 'PAGADO' : 'ABONO'
  const stampColor = paid ? GREEN : AMBER
  const sy = y - 46
  page.pushOperators(setCharacterSpacing(2.4))
  const stampWidth = bold.widthOfTextAtSize(stamp, 12) + 2.4 * (stamp.length - 1)
  page.drawRectangle({ x: left, y: sy - 7, width: stampWidth + 20, height: 26, borderColor: stampColor, borderWidth: 2, rotate: degrees(6), opacity: 0 })
  page.drawText(stamp, { x: left + 10, y: sy + 2, size: 12, font: bold, color: stampColor, rotate: degrees(6) })
  page.pushOperators(setCharacterSpacing(0))
  let ny = sy - 30
  const notes = [
    ...(r.nextDueOn && paid ? [`Próximo cobro: ${long(r.nextDueOn)}.`] : []),
    ...(r.pendingCents > 0 && r.nextDueOn ? [`Quedan ${money(r.pendingCents)} por pagar de este período.`] : []),
    ...(r.excessCents > 0 ? [`Los ${money(r.excessCents)} pagados de más quedan en su saldo a favor y se descuentan solos en su próximo cobro.`] : []),
  ]
  for (const note of notes) {
    for (const line of wrap(regular, 8.5, note, tx - left - 30, 3)) {
      text(page, line, left, ny, regular, 8.5, MUTED)
      ny -= 11.5
    }
  }

  // Footer.
  page.drawLine({ start: { x: left, y: 52 }, end: { x: end, y: 52 }, thickness: 0.8, color: SOFT })
  text(page, 'Recibo de pago de la suscripción a Vortomi. No es una factura fiscal.', left, 38, regular, 8.5, MUTED)
  right(page, 'Página 1 de 1', end, 38, regular, 8.5, MUTED)

  return doc.save()
}

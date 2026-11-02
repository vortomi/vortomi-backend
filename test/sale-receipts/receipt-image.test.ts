// The receipt picture: one layout for every company, with its own data, the sale's lines in their
// units and totals that add up; whatever a company or a customer wrote is text, never markup.
import { describe, expect, it } from 'vitest'
import { type ReceiptData, DISCLAIMER, receiptSvg, renderReceipt, wrap } from '../../src/modules/sale-receipts/receipt-image.ts'
import { suggestedFooter, suggestedPrefix } from '../../src/modules/sale-receipts/receipt-defaults.ts'

const DATA: ReceiptData = {
  business: { name: 'Charcutería <Don Pepe>', subtitle: 'Sucursal Centro', legalName: 'Inversiones Pepe, C.A.', taxId: 'J-41234567-8', address: 'Av. Bolívar', phone: '0412-1234567' },
  logo: null,
  code: 'CDP-000007',
  issuedAt: new Date('2026-11-02T22:59:00Z'),
  timezone: 'America/Caracas',
  attendedBy: 'Laura',
  customerName: 'María & José',
  lines: [
    { name: 'Queso blanco duro', quantity: 0.15, saleUnit: 'kg', unitPriceCents: 999 },
    { name: 'Refresco', quantity: 2, saleUnit: 'unit', unitPriceCents: 90 },
  ],
  fulfillment: 'delivery',
  deliveryCents: 100,
  bsPerUsd: '100.00',
  paymentMethod: 'Pago móvil',
  paymentReference: '000123',
  footer: 'Garantía de 30 días.',
}

describe('the receipt picture', () => {
  it('prints the business, the sale in its units, totals that add up, the payment and the disclaimer', () => {
    const svg = receiptSvg(DATA)
    for (const text of ['CDP-000007', '02/11/2026', '0,15 kg', '$1,50', '$1,80', 'Subtotal:', '$3,30', '$4,30 USD', 'Bs 430,00', 'Pago móvil', '000123', 'RIF J-41234567-8', 'Garantía de 30 días.']) {
      expect(svg).toContain(text)
    }
    expect(svg).toContain(DISCLAIMER.slice(0, 40))
  })

  it('writes what people typed as text, never as markup', () => {
    const svg = receiptSvg(DATA)
    expect(svg).toContain('CHARCUTERÍA &lt;DON PEPE&gt;')
    expect(svg).toContain('María &amp; José')
    expect(svg).not.toContain('<DON PEPE>')
  })

  it('leaves out what the company chose not to show', () => {
    const svg = receiptSvg({ ...DATA, attendedBy: null, paymentReference: null, bsPerUsd: null, fulfillment: 'pickup' })
    for (const text of ['Atendido por', 'Referencia', 'Equivalente', 'Envío']) expect(svg).not.toContain(text)
  })

  it('is a PNG twice as wide as the drawing, sharp on a phone', () => {
    const png = renderReceipt(DATA)
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(png.readUInt32BE(16)).toBe(1200)
  })

  it('wraps long words and lines to the width', () => {
    expect(wrap('Botellón Nuevo 19L con tapa de seguridad', 24)).toEqual(['Botellón Nuevo 19L con', 'tapa de seguridad'])
    expect(wrap('Supercalifragilisticoespialidoso', 10)).toEqual(['Supercalif', 'ragilistic', 'oespialido', 'so'])
  })
})

describe('what a receipt starts with', () => {
  it('a prefix from the company name and a footer from its business type', () => {
    expect(suggestedPrefix('Agua Potable La Campiña')).toBe('APC')
    expect(suggestedPrefix('El Sol')).toBe('S')
    expect(suggestedPrefix('?')).toBe('REC')
    expect(suggestedFooter('pharmacy')).toContain('no tienen cambio')
    expect(suggestedFooter(null)).toBe('¡Gracias por su compra!')
  })
})

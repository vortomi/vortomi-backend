import type { PaymentCurrency } from './payment-method-types.ts'
import type { PaymentMethodView } from './payment-method-service.ts'

// The message the customer gets once they confirm an order: how to pay it, written by the server
// from the company's own data. The model never copies account numbers or amounts, so it cannot get
// them wrong. It speaks as the business itself ("lo revisamos"), and the order code stays internal.

const number = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "Bs 1.234,56", "USD 12,50"; null in bolívares while the company has no exchange rate. */
export function amountText(cents: number, currency: PaymentCurrency, bsPerUsd: string | null, binance = false): string | null {
  const usd = cents / 100
  if (currency !== 'VES') return `${binance ? 'USDT' : 'USD'} ${number.format(usd)}`
  if (!bsPerUsd) return null
  return `Bs ${number.format(Math.round(usd * Number(bsPerUsd) * 100) / 100)}`
}

export interface OrderToPay {
  customerName: string
  /** Products and the delivery whose cost is known. */
  totalCents: number
  /** Delivery whose cost is still to be confirmed: not in the total. */
  deliveryPending: boolean
  bsPerUsd: string | null
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

/** One message: the call to pay, the method's data, the amount, and what to send back. */
export function paymentMessage(method: PaymentMethodView, order: OrderToPay): string {
  const proof = method.receiptRule !== 'none' || method.referenceRule !== 'none'
  const amount = amountText(order.totalCents, method.currency, order.bsPerUsd, method.type === 'binance')
  const lines = [
    proof
      ? `¡Perfecto, ${firstName(order.customerName)}! Para registrar tu pedido, por favor realiza el pago por ${method.name}:`
      : `¡Perfecto, ${firstName(order.customerName)}! Tu pedido se paga con ${method.name}:`,
    '',
  ]
  for (const field of method.fields) lines.push(`${field.label}: ${field.value}`)
  if (method.type !== 'arrange') {
    lines.push(`Monto a pagar: ${amount ?? 'te lo confirmamos en un momento'}${order.deliveryPending ? ' + el delivery, que te confirmamos en un momento' : ''}`)
  }
  if (method.currency === 'EUR') lines.push('El equivalente en euros te lo confirmamos en un momento.')
  // The company's own instructions say what to send back; without them, we say it.
  lines.push('', method.instructions || closing(method))
  return lines.join('\n').trimEnd()
}

function closing(method: PaymentMethodView): string {
  if (method.receiptRule !== 'none') {
    return method.referenceRule === 'required'
      ? 'Cuando pagues, envíanos por aquí el capture del comprobante, con el número de referencia visible.'
      : 'Cuando pagues, envíanos por aquí el capture del comprobante.'
  }
  if (method.referenceRule !== 'none') return 'Cuando pagues, envíanos por aquí el número de referencia.'
  return 'Lo revisamos y te confirmamos en breve.'
}

import type { PaymentMethodType } from '../../db/schema/enums.ts'

/** The currency a customer pays a method in: it follows the type, nobody types it. */
export type PaymentCurrency = 'VES' | 'USD' | 'EUR'

const CURRENCY: Record<PaymentMethodType, PaymentCurrency> = {
  pago_movil: 'VES',
  transfer_national: 'VES',
  cash_ves: 'VES',
  cash_eur: 'EUR',
  zelle: 'USD',
  paypal: 'USD',
  // USDT, 1:1 with the dollar.
  binance: 'USD',
  transfer_international: 'USD',
  cash_usd: 'USD',
  arrange: 'USD',
}

export const currencyOf = (type: PaymentMethodType): PaymentCurrency => CURRENCY[type]

/** Paid in person or agreed with the seller: no reference and no receipt is asked for. */
const NO_PROOF: ReadonlySet<PaymentMethodType> = new Set(['cash_usd', 'cash_ves', 'cash_eur', 'arrange'])

export const takesNoProof = (type: PaymentMethodType): boolean => NO_PROOF.has(type)

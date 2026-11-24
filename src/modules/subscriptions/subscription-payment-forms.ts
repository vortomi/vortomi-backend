import { z } from 'zod'
import type { PaymentMethodType, PaymentProofRule } from '../../db/schema/enums.ts'
import type { PayerDetails, SubscriptionPaymentCurrency } from '../../db/schema/subscription-payments.ts'
import { currencyOf } from '../payment-methods/payment-method-types.ts'
import { hasValidFormat } from '../payment-methods/venezuelan-formats.ts'

// The payment report form of each kind of method (documentations/18 §5, mockup web-40): what it
// asks about who paid, the format of its reference, and the receipt. Keep in sync with the panel's
// copy (vortomi-frontend/src/app/features/subscription/payment-forms.ts).

/** The payment does not fit its method's form; `code` says what, for the panel's message. */
export class PaymentFormError extends Error {
  constructor(readonly code: string) {
    super(`Payment form: ${code}`)
    this.name = 'PaymentFormError'
  }
}

const NAME = /^\p{L}[\p{L}\s'.-]{2,59}$/u
const EMAIL = z.email().max(120)
const isEmail = (value: string) => EMAIL.safeParse(value).success
/** A phone of the United States: 10 digits, with or without the +1. */
const isUsPhone = (value: string) => /^1?\d{10}$/.test(value.replace(/[\s().+-]/g, ''))
/** Any phone with its country code: 8 to 15 digits. */
const isPhone = (value: string) => /^\+?\d{8,15}$/.test(value.replace(/[\s().-]/g, ''))

type Check = (value: string) => boolean

interface PayerField {
  key: string
  check: Check
}

const bank: PayerField = { key: 'bank', check: (v) => hasValidFormat('bank', v) }
const phone: PayerField = { key: 'phone', check: (v) => hasValidFormat('phone', v) }
const document: PayerField = { key: 'document', check: (v) => hasValidFormat('document', v) }
const holder: PayerField = { key: 'holder', check: (v) => NAME.test(v) }

interface MethodForm {
  payer: PayerField[]
  /** null: the method has no reference (cash). */
  reference: RegExp | null
}

/**
 * The form of each method Vortomi may be paid with. «A convenir» and cash in euros are left out:
 * Vortomi has no rate for the euro, and an agreed payment has nothing to check.
 */
const FORMS: Partial<Record<PaymentMethodType, MethodForm>> = {
  // Banks print references of different lengths: digits only, whole, as on the receipt.
  pago_movil: { payer: [bank, phone, document], reference: /^\d{4,20}$/ },
  transfer_national: { payer: [bank, holder, document], reference: /^\d{4,20}$/ },
  // Each bank gives its own Zelle confirmation: the sender is what finds it in Vortomi's account.
  zelle: { payer: [{ key: 'senderName', check: (v) => NAME.test(v) }, { key: 'senderContact', check: (v) => isEmail(v) || isUsPhone(v) }], reference: /^[A-Z0-9]{4,30}$/ },
  // Binance ID, e-mail or phone (Pay ID is gone); the order ID is up to 32 letters or digits.
  binance: { payer: [{ key: 'sender', check: (v) => /^\d{6,12}$/.test(v) || isEmail(v) || isPhone(v) }], reference: /^[A-Z0-9]{6,32}$/ },
  // A PayPal transaction ID has 17 characters; an order ID, 19.
  paypal: { payer: [{ key: 'senderEmail', check: isEmail }], reference: /^(?:[A-Z0-9]{17}|[A-Z0-9]{19})$/ },
  transfer_international: { payer: [{ key: 'bank', check: (v) => v.length >= 2 && v.length <= 60 }, holder], reference: /^[A-Z0-9-]{4,40}$/ },
  cash_usd: { payer: [{ key: 'receivedBy', check: (v) => NAME.test(v) }], reference: null },
  cash_ves: { payer: [{ key: 'receivedBy', check: (v) => NAME.test(v) }], reference: null },
}

/** Whether companies may pay Vortomi with a method of this type. */
export const payableType = (type: PaymentMethodType): boolean => FORMS[type] !== undefined

/** "000 451 287" -> "000451287": as the bank prints it, without spaces, in capitals. */
export const normalizeReference = (text: string) => text.replace(/\s+/g, '').toUpperCase()

export interface MethodRules {
  type: PaymentMethodType
  referenceRule: PaymentProofRule
}

/** Who paid and the reference, checked against the method's form. Unknown keys are dropped. */
export function checkPayer(method: MethodRules, payer: Record<string, string>, reference: string | undefined): { payer: PayerDetails; reference: string | null } {
  const form = FORMS[method.type]
  if (!form) throw new PaymentFormError('method_unavailable')
  const clean: PayerDetails = {}
  for (const field of form.payer) {
    const value = (payer[field.key] ?? '').trim()
    if (!value || !field.check(value)) throw new PaymentFormError(`invalid_${field.key}`)
    clean[field.key] = value
  }
  const typed = normalizeReference(reference ?? '')
  if (!form.reference || method.referenceRule === 'none') return { payer: clean, reference: null }
  if (!typed) {
    if (method.referenceRule === 'required') throw new PaymentFormError('reference_required')
    return { payer: clean, reference: null }
  }
  if (!form.reference.test(typed)) throw new PaymentFormError('invalid_reference')
  return { payer: clean, reference: typed }
}

/** "1234.56" in the method's currency: more than 0, at most 2 decimals. */
export const amountInput = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).refine((v) => Number(v) > 0)

/** The currency of a method companies may pay with (USD or VES). */
export function paymentCurrency(type: PaymentMethodType): SubscriptionPaymentCurrency {
  const currency = currencyOf(type)
  if (currency === 'EUR') throw new PaymentFormError('method_unavailable')
  return currency
}

/** A payment's amount in dollar cents: as is in dollars, at Vortomi's rate in bolívares. */
export function toUsdCents(amount: string, currency: SubscriptionPaymentCurrency, bsPerUsd: string | null): number {
  if (currency === 'USD') return Math.round(Number(amount) * 100)
  if (!bsPerUsd || Number(bsPerUsd) <= 0) throw new PaymentFormError('rate_missing')
  return Math.round((Number(amount) / Number(bsPerUsd)) * 100)
}

// The receipt: an image or a PDF of up to 5 MB, sent as base64 and checked by its first bytes.

export const MAX_PROOF_BYTES = 5 * 1024 * 1024
export const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export type ProofType = (typeof PROOF_TYPES)[number]

export const proofInput = z.object({ mimeType: z.enum(PROOF_TYPES), data: z.base64().max(Math.ceil(MAX_PROOF_BYTES / 3) * 4) })
export type ProofInput = z.infer<typeof proofInput>

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))
const startsWith = (bytes: Buffer, signature: number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte)
const IS: Record<ProofType, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  'application/pdf': (b) => startsWith(b, ascii('%PDF-')),
}

/** The receipt's bytes, if they are the file they say they are and within 5 MB. */
export function readProof(input: ProofInput): { bytes: Buffer; mimeType: ProofType } {
  const bytes = Buffer.from(input.data, 'base64')
  if (!bytes.length || bytes.length > MAX_PROOF_BYTES || !IS[input.mimeType](bytes)) throw new PaymentFormError('invalid_proof')
  return { bytes, mimeType: input.mimeType }
}

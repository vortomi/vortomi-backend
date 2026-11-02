import type { PaymentFieldKind } from '../../db/schema/enums.ts'

// Formats of the Venezuelan payment data. Keep in sync with the panel's copy
// (vortomi-frontend/src/app/features/payment-methods/venezuelan-formats.ts).

/** Codes of the banks in Venezuela (SUDEBAN). */
export const BANK_CODES: ReadonlySet<string> = new Set([
  '0102', '0104', '0105', '0108', '0114', '0115', '0128', '0134', '0137', '0138', '0146', '0151', '0156',
  '0157', '0163', '0166', '0168', '0169', '0171', '0172', '0173', '0174', '0175', '0177', '0178', '0191',
])

/** "0134 · Banesco": the code and the bank's name. */
const BANK = /^(\d{4}) · \S.{0,79}$/
/** Cédula (V/E, 6-8 digits), RIF of a company or government (J/G, 8 digits and a check digit), or passport. */
const DOCUMENT = /^(?:[VE]-\d{6,8}(?:-\d)?|[JG]-\d{8}-\d|P-[A-Z0-9]{6,15})$/
/** Mobile numbers: "0414-1234567". */
const PHONE = /^04(?:12|14|16|22|24|26)-\d{7}$/

/** Whether a datum's value has its kind's format (free text always does). */
export function hasValidFormat(kind: PaymentFieldKind, value: string): boolean {
  switch (kind) {
    case 'bank': {
      const code = BANK.exec(value)?.[1]
      return code !== undefined && BANK_CODES.has(code)
    }
    case 'document':
      return DOCUMENT.test(value)
    case 'phone':
      return PHONE.test(value)
    case 'text':
      return true
  }
}

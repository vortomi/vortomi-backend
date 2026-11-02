import { DECIMAL_SALE_UNITS, type SaleUnit } from '../../db/schema/enums.ts'

// How much of a product can be sold, the same for the inventory and for orders. Quantities keep
// 2 decimals: 0,10 kg is 100 g, and nobody orders a single gram.

/** How a product is sold: its unit, the least a customer can take and the size of each step. */
export interface SaleRule {
  saleUnit: SaleUnit
  minQuantity: number
  quantityStep: number
}

/** Pieces count whole; one product unit for whoever has no rule (a company's own system). */
export const UNIT_RULE: SaleRule = { saleUnit: 'unit', minQuantity: 1, quantityStep: 1 }

/** The choices the panel offers for "Venta mínima" and "De cuánto en cuánto" (closed lists). */
export const MIN_QUANTITIES = [0.1, 0.25, 0.5, 1, 2, 3, 5, 6, 10, 12] as const
export const QUANTITY_STEPS = [0.05, 0.1, 0.25, 0.5, 1] as const

/** A whole number of hundredths (float-safe: 0,1 + 0,2 still counts as 0,3). */
const isWholeMultiple = (value: number, of: number) => Math.abs(value / of - Math.round(value / of)) < 1e-9

export function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
}

export function takesDecimals(unit: SaleUnit): boolean {
  return DECIMAL_SALE_UNITS.includes(unit)
}

/** A quantity in the product's unit: whole for pieces, up to 2 decimals for kilos, metres... */
export function fitsUnit(value: number, unit: SaleUnit): boolean {
  return takesDecimals(unit) ? hasAtMostTwoDecimals(value) : Number.isInteger(value)
}

/** The minimum and the step a product may have: whole for pieces, a whole number of steps otherwise. */
export function fitsRule({ saleUnit, minQuantity, quantityStep }: SaleRule): boolean {
  return takesDecimals(saleUnit) ? isWholeMultiple(minQuantity, quantityStep) : quantityStep === 1 && Number.isInteger(minQuantity)
}

/** What one customer may order: in the unit, from the minimum up, in whole steps. */
export function canSell(quantity: number, rule: SaleRule): boolean {
  return fitsUnit(quantity, rule.saleUnit) && quantity >= rule.minQuantity - 1e-9 && isWholeMultiple(quantity, rule.quantityStep)
}

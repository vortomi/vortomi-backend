/**
 * Reads the official dollar rate from the BCV home page (bcv.org.ve, 20/10/2026): the amount inside
 * <div id="dolar"> ("881,87690000") and the "Fecha Valor" it applies from
 * (content="2026-10-20T00:00:00-04:00"). Null when the page no longer has that shape.
 */
export interface BcvRate {
  /** Bolivars per dollar with a decimal point: "881.87690000". */
  bsPerUsd: string
  /** The day it applies from: "2026-10-20". */
  effectiveDate: string
}

/** How far past <div id="dolar"> the amount may be. */
const DOLLAR_BLOCK = 800

export function parseBcvPage(html: string): BcvRate | null {
  const start = html.indexOf('id="dolar"')
  if (start < 0) return null
  const block = html.slice(start, start + DOLLAR_BLOCK)
  const amount = /<strong[^>]*>\s*([\d.]+,\d+|\d+)\s*<\/strong>/.exec(block)?.[1]
  const date = /Fecha Valor:[\s\S]{0,300}?content="(\d{4}-\d{2}-\d{2})T/.exec(html)?.[1]
  if (!amount || !date) return null
  // "1.234,56" (Spanish thousands and decimals) -> "1234.56".
  const bsPerUsd = amount.replace(/\./g, '').replace(',', '.')
  if (!/^\d{1,10}(\.\d{1,8})?$/.test(bsPerUsd) || Number(bsPerUsd) <= 0) return null
  return { bsPerUsd, effectiveDate: date }
}

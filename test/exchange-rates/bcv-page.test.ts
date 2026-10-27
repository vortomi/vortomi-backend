import { describe, expect, it } from 'vitest'
import { parseBcvPage } from '../../src/modules/exchange-rates/bcv-page.ts'

/** The pieces of bcv.org.ve the parser reads, as the page had them on 19/10/2026. */
const page = (amount: string, date = '2026-10-20') => `
  <div id="euro"><strong class="strong-tb">1.024,51230000</strong></div>
  <div id="dolar" class="col-sm-12 col-xs-12 ">
    <div class="field-content"><div class="row recuadrotsmc">
      <div class="col-sm-6 col-xs-6"><img src="/dollar.png"> <span> USD</span> </div>
      <div class="col-sm-6 col-xs-6 centrado textp"> <strong class="strong-tb">${amount}</strong>  </div>
    </div></div>
  </div>
  <div class="pull-right dinpro center">Fecha Valor: <span class="date-display-single" property="dc:date"
    datatype="xsd:dateTime" content="${date}T00:00:00-04:00">Martes, 20 Octubre  2026</span></div>`

describe('parseBcvPage', () => {
  it('reads the dollar (not the euro) and its fecha valor', () => {
    expect(parseBcvPage(page('881,87690000'))).toEqual({
      bsPerUsd: '881.87690000',
      effectiveDate: '2026-10-20',
    })
  })

  it('understands thousands separators', () => {
    expect(parseBcvPage(page('1.234,50'))?.bsPerUsd).toBe('1234.50')
  })

  it('gives up when the page changed', () => {
    expect(parseBcvPage('<html>Mantenimiento</html>')).toBeNull()
    expect(parseBcvPage(page('sin tasa'))).toBeNull()
    expect(parseBcvPage(page('0,00'))).toBeNull()
    expect(parseBcvPage(page('881,87').replace('Fecha Valor:', ''))).toBeNull()
  })
})

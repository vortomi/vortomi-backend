import { X509Certificate } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { BCV_TRUSTED_CA, SECTIGO_DV_R36 } from '../../src/modules/exchange-rates/bcv-tls.ts'

describe('BCV_TRUSTED_CA', () => {
  const intermediate = new X509Certificate(SECTIGO_DV_R36)

  it('adds the Sectigo DV R36 intermediate to the Node roots', () => {
    expect(intermediate.subject).toContain('CN=Sectigo Public Server Authentication CA DV R36')
    expect(intermediate.fingerprint256).toBe(
      '8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0',
    )
    expect(BCV_TRUSTED_CA).toEqual([...rootCertificates, SECTIGO_DV_R36])
  })

  it('chains to a root Node already trusts and is still valid', () => {
    const issuer = rootCertificates
      .map((pem) => new X509Certificate(pem))
      .find((root) => intermediate.checkIssued(root) && intermediate.verify(root.publicKey))
    expect(issuer?.subject).toContain('Sectigo Public Server Authentication Root R46')
    expect(new Date(intermediate.validTo).getTime()).toBeGreaterThan(Date.now())
  })
})

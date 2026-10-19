import { describe, expect, it } from 'vitest'
import { SERVICE_WINDOW_MS, isWithinServiceWindow } from '../../src/modules/messaging/service-window.ts'

const now = new Date('2026-10-02T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('isWithinServiceWindow', () => {
  it('is closed when the customer never wrote', () => {
    expect(isWithinServiceWindow(null, now)).toBe(false)
  })

  it('is open up to just before 24 hours', () => {
    expect(isWithinServiceWindow(ago(SERVICE_WINDOW_MS - 1), now)).toBe(true)
  })

  it('is closed at exactly 24 hours', () => {
    expect(isWithinServiceWindow(ago(SERVICE_WINDOW_MS), now)).toBe(false)
  })

  it('tolerates a customer timestamp slightly ahead of this clock', () => {
    expect(isWithinServiceWindow(ago(-5_000), now)).toBe(true)
  })
})

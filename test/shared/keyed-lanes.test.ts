// Automatic answers run in lanes: in order within a conversation, side by side across them, never
// more than the limit at once; a failing job is reported and the lane goes on.
import { describe, expect, it } from 'vitest'
import { KeyedLanes } from '../../src/shared/keyed-lanes.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('KeyedLanes', () => {
  it('keeps order within a lane and runs lanes side by side, up to the limit', async () => {
    const lanes = new KeyedLanes(2, () => undefined)
    const log: string[] = []
    let running = 0
    let peak = 0
    const job = (name: string) => async () => {
      running++
      peak = Math.max(peak, running)
      log.push(`start ${name}`)
      await tick()
      log.push(`end ${name}`)
      running--
    }
    lanes.run('a', job('a1'))
    lanes.run('a', job('a2'))
    lanes.run('b', job('b1'))
    lanes.run('c', job('c1'))
    await lanes.idle()
    expect(peak).toBe(2)
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'))
    expect(log.filter((l) => l.startsWith('end'))).toHaveLength(4)
    expect(lanes.size).toBe(0)
  })

  it('reports a failing job and keeps the lane going', async () => {
    const failures: string[] = []
    const lanes = new KeyedLanes(1, (key) => failures.push(key))
    let after = false
    lanes.run('a', () => Promise.reject(new Error('boom')))
    lanes.run('a', () => {
      after = true
      return Promise.resolve()
    })
    await lanes.idle()
    expect(failures).toEqual(['a'])
    expect(after).toBe(true)
  })

  it('stops waiting at the timeout', async () => {
    const lanes = new KeyedLanes(1, () => undefined)
    lanes.run('slow', () => new Promise((resolve) => setTimeout(resolve, 2_000)))
    const started = Date.now()
    await lanes.idle(30)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

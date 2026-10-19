import { describe, expect, it, vi } from 'vitest'
import { SerialQueue } from '../../src/modules/inbox/serial-queue.ts'

describe('SerialQueue', () => {
  it('runs jobs one at a time, in order', async () => {
    const log: string[] = []
    const queue = new SerialQueue(async (key) => {
      log.push(`start ${key}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      log.push(`end ${key}`)
    }, vi.fn())

    queue.push(1)
    queue.push(2)
    await queue.idle()

    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('ignores a key that is already waiting or running', async () => {
    const worker = vi.fn(() => Promise.resolve())
    const queue = new SerialQueue(worker, vi.fn())

    expect(queue.push(7)).toBe(true)
    expect(queue.push(7)).toBe(false)
    await queue.idle()
    expect(worker).toHaveBeenCalledTimes(1)
    expect(queue.push(7)).toBe(true)
    await queue.idle()
  })

  it('reports a failing job and keeps processing the next ones', async () => {
    const onError = vi.fn()
    const done: number[] = []
    const queue = new SerialQueue(async (key) => {
      if (key === 1) throw new Error('boom')
      done.push(key)
      return Promise.resolve()
    }, onError)

    queue.push(1)
    queue.push(2)
    await queue.idle()

    expect(onError).toHaveBeenCalledWith(1, expect.any(Error))
    expect(done).toEqual([2])
  })
})

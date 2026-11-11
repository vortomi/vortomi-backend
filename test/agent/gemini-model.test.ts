// Gemini through its REST API: a call that fails for a moment (busy, overloaded, network) is tried
// again before giving up; a refused request is not. Fetch is a fake: no call leaves the test.
import { describe, expect, it } from 'vitest'
import { ModelBusyError } from '../../src/modules/agent/chat-model.ts'
import { GeminiModel } from '../../src/modules/agent/gemini-model.ts'

const answer = () => Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hola' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })
const busy = () => Response.json({ error: { message: 'overloaded' } }, { status: 503 })

function fakeFetch(...responses: (() => Response | Promise<Response>)[]) {
  let calls = 0
  const fn = (() => {
    const next = responses[calls++]
    return next ? Promise.resolve(next()) : Promise.reject(new Error('no more answers'))
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

const request = { system: 'Eres un vendedor.', history: [{ from: 'customer' as const, text: 'Hola' }], tools: [] }

describe('GeminiModel', () => {
  it('tries again when the model is busy for a moment, or the network drops', async () => {
    const api = fakeFetch(busy, () => Promise.reject(new TypeError('fetch failed')), answer)
    const reply = await new GeminiModel('key', 'gemini-test', api.fn, [1, 1]).reply(request)
    expect(reply.text).toBe('Hola')
    expect(api.calls()).toBe(3)
  })

  it('gives up after its retries, saying the model is busy', async () => {
    const api = fakeFetch(busy, busy, busy)
    await expect(new GeminiModel('key', 'gemini-test', api.fn, [1, 1]).reply(request)).rejects.toBeInstanceOf(ModelBusyError)
    expect(api.calls()).toBe(3)
  })

  it('does not retry a refused request', async () => {
    const api = fakeFetch(() => Response.json({ error: { message: 'bad key' } }, { status: 400 }), answer)
    await expect(new GeminiModel('key', 'gemini-test', api.fn, [1, 1]).reply(request)).rejects.toThrow('Gemini 400')
    expect(api.calls()).toBe(1)
  })
})

import { type AgentTool, type ChatModel, type ChatReply, type ChatRequest, ModelBusyError } from './chat-model.ts'

const API = 'https://generativelanguage.googleapis.com/v1beta/models'
/** Model turns that may call tools before the agent must have answered. */
const MAX_ROUNDS = 4
// The free tier takes 20-30 s per call (measured 29 Oct 2026); paid answers in seconds.
const TIMEOUT_MS = 60_000
/** Waits before trying again a call that failed for a moment (busy, overloaded, slow, network). */
const RETRY_DELAYS_MS = [2_000, 6_000]
/** Gemini's own "try again in N s" is followed up to this long. */
const MAX_RETRY_AFTER_MS = 15_000

/** A Gemini content: kept as the API returns it, so whatever it carries (thought signatures) goes back intact. */
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}
type Part =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  promptFeedback?: { blockReason?: string }
}

/**
 * Google's Gemini through its REST API (generateContent with function calling). Runs the tool
 * loop itself: the model asks for a tool, the agent's code runs it, the result goes back, until
 * the model writes the answer.
 */
export class GeminiModel implements ChatModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {}

  async reply(request: ChatRequest): Promise<ChatReply> {
    const contents = toContents(request.history)
    const tools = new Map(request.tools.map((tool) => [tool.name, tool]))
    const usage = { inputTokens: 0, outputTokens: 0 }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await this.generate(request.system, contents, request.tools)
      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0
      usage.outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0)
      const content = response.candidates?.[0]?.content
      if (!content?.parts?.length) throw new Error(`Gemini gave no answer (${response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason ?? 'empty'})`)

      const calls = content.parts.flatMap((part) => ('functionCall' in part ? [part.functionCall] : []))
      if (!calls.length) {
        const text = content.parts.flatMap((part) => ('text' in part && !part.thought ? [part.text] : [])).join('').trim()
        if (!text) throw new Error('Gemini answered with no text')
        return { text, usage }
      }
      contents.push(content)
      contents.push({ role: 'user', parts: await Promise.all(calls.map((call) => runTool(tools, call))) })
    }
    throw new Error(`Gemini kept calling tools after ${MAX_ROUNDS} rounds`)
  }

  /**
   * One model call, tried again when it failed only for a moment (busy, overloaded, too slow or the
   * network): a customer should not be passed to a person because Gemini hiccupped once.
   */
  private async generate(system: string, contents: Content[], tools: AgentTool[]): Promise<GenerateResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call(system, contents, tools)
      } catch (error) {
        const delay = this.retryDelaysMs[attempt]
        if (delay === undefined || !passing(error)) throw error
        // Gemini's own "try again in N s" wins, within limits (at most 10 times our own wait, and 15 s).
        await sleep(error instanceof ModelBusyError && error.retryAfterMs ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS, Math.max(delay, 1) * 10) : delay)
      }
    }
  }

  private async call(system: string, contents: Content[], tools: AgentTool[]): Promise<GenerateResponse> {
    const response = await this.fetchFn(`${API}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      // The key goes in a header, never in the URL (it would end up in logs).
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: tools.length ? [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] : undefined,
        generationConfig: { maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 429 || response.status === 500 || response.status === 503) {
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new ModelBusyError(`${response.status} ${await errorMessage(response)}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null)
    }
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${await errorMessage(response)}`)
    return (await response.json()) as GenerateResponse
  }
}

/** A failure worth one more try: the model busy, a timeout or the network; never a refused request. */
function passing(error: unknown): boolean {
  if (error instanceof ModelBusyError) return true
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError' || (error.name === 'TypeError' && error.message.includes('fetch'))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Customer and business turns as Gemini wants them: starting with the customer, alternating. */
function toContents(history: ChatRequest['history']): Content[] {
  const contents: Content[] = []
  for (const turn of history) {
    const role = turn.from === 'customer' ? 'user' : 'model'
    if (!contents.length && role === 'model') continue
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push({ text: turn.text })
    else contents.push({ role, parts: [{ text: turn.text }] })
  }
  return contents
}

async function runTool(tools: Map<string, AgentTool>, call: { name: string; args?: Record<string, unknown> }): Promise<Part> {
  const tool = tools.get(call.name)
  let result: unknown
  try {
    result = tool ? await tool.run(call.args ?? {}) : { error: `Unknown tool ${call.name}` }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : 'Tool failed' }
  }
  return { functionResponse: { name: call.name, response: { result } } }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message ?? response.statusText
  } catch {
    return response.statusText
  }
}

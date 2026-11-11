// What the sales agent needs from a language model, whoever provides it (Gemini today; another
// provider tomorrow by writing one more adapter, not by touching the agent).

/** Something the model may ask the agent to do: look products up, pass the chat to a person. */
export interface AgentTool {
  name: string
  description: string
  /** JSON Schema of the arguments (object at the top). */
  parameters: Record<string, unknown>
  /** Runs it; what it returns is shown to the model as the result. */
  run(args: Record<string, unknown>): Promise<unknown>
}

/** One message of the conversation, oldest first. */
export interface ChatTurn {
  from: 'customer' | 'business'
  text: string
}

export interface ChatRequest {
  system: string
  history: ChatTurn[]
  tools: AgentTool[]
}

export interface ChatReply {
  /** What to send to the customer. */
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

export interface ChatModel {
  reply(request: ChatRequest): Promise<ChatReply>
}

/** The provider said no for now (quota or rate limit): a person should answer this one. */
export class ModelBusyError extends Error {
  constructor(
    detail: string,
    /** How long the model asked to wait before trying again, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Model unavailable for now: ${detail}`)
    this.name = 'ModelBusyError'
  }
}

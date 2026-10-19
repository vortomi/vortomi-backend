// Positional parameters of a template body: {{1}}, {{2}}... (Meta's default format).

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g

export class InvalidTemplateError extends Error {
  constructor(reason: string) {
    super(`Invalid template: ${reason}`)
    this.name = 'InvalidTemplateError'
  }
}

/** How many parameters the body takes. They must be numbered 1..n with no gaps. */
export function parameterCount(body: string): number {
  const numbers = [...body.matchAll(PLACEHOLDER)].map((match) => Number(match[1]))
  const distinct = [...new Set(numbers)].sort((x, y) => x - y)
  if (distinct.some((number, index) => number !== index + 1)) throw new InvalidTemplateError('parameters must be {{1}}..{{n}} with no gaps')
  return distinct.length
}

/** The text the customer receives, for the conversation history. */
export function renderBody(body: string, parameters: readonly string[]): string {
  if (parameters.length !== parameterCount(body)) throw new InvalidTemplateError('wrong number of parameters')
  return body.replace(PLACEHOLDER, (_match, number: string) => parameters[Number(number) - 1] ?? '')
}

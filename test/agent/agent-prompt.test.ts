// The agent's instructions: common sense first. A greeting is answered as a greeting, and a product
// system that cannot be read is only mentioned when the customer asks about products.
import { describe, expect, it } from 'vitest'
import { type PromptFacts, systemPrompt } from '../../src/modules/agent/agent-prompt.ts'

const facts: PromptFacts = {
  companyName: 'Agua Potable La Campiña',
  assistantName: 'Vorti',
  tone: 'friendly',
  businessInfo: 'Vendemos agua potable en botellones.',
  hours: [],
  openNow: true,
  bsPerUsd: '893.21',
}

describe('systemPrompt', () => {
  it('answers what the customer just said: a greeting gets a greeting, no unasked offers', () => {
    const prompt = systemPrompt(facts)
    expect(prompt).toContain('Answer what the customer\'s latest message actually says')
    expect(prompt).toContain('do not bring up products, prices, orders or passing them to someone unless they ask')
  })

  it('with the product system down, only mentions it when the customer asks about products', () => {
    const down = systemPrompt({ ...facts, catalogUnavailable: true })
    expect(down).toContain('Only when the customer asks about products')
    expect(down).toContain('call hand_off_to_person with reason "catalog_unavailable" right away')
    expect(down).toContain('For greetings and anything else, answer normally and do not mention it.')
    expect(systemPrompt(facts)).not.toContain('cannot be read right now')
  })
})

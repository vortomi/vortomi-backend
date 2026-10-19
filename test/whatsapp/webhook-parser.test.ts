import { describe, expect, it } from 'vitest'
import { eventIdOf, routingKeyOf } from '../../src/modules/whatsapp/events.ts'
import { parseWebhookPayload } from '../../src/modules/whatsapp/webhook-parser.ts'
import { PHONE_A, PHONE_B, change, statusChange, templateStatusWebhook, textChange, unix, webhook } from '../helpers/meta-payloads.ts'

describe('parseWebhookPayload', () => {
  it('tags every event with the number it arrived on', () => {
    const { events, skipped } = parseWebhookPayload(webhook(textChange(PHONE_A, 'wamid.1', 'hola'), statusChange(PHONE_B, 'wamid.2', 'read')))
    expect(skipped).toEqual([])
    expect(events.map((e) => [e.kind, routingKeyOf(e), eventIdOf(e)])).toEqual([
      ['inbound_message', PHONE_A, 'wamid.1'],
      ['status_update', PHONE_B, 'wamid.2'],
    ])
  })

  it('reads the customer, the name Meta reports and the text', () => {
    const at = new Date('2026-10-13T10:00:00-04:00')
    const [event] = parseWebhookPayload(webhook(textChange(PHONE_A, 'wamid.1', 'hola', '584121111111', at))).events
    expect(event).toMatchObject({ from: '584121111111', profileName: 'María Pérez', type: 'text', body: 'hola', timestamp: at })
  })

  it('skips a change without a number instead of guessing whose it is', () => {
    const payload = webhook(change(null, { messages: [{ id: 'wamid.1', from: '58412', timestamp: unix(new Date()), type: 'text', text: { body: 'x' } }] }))
    expect(parseWebhookPayload(payload)).toEqual({ events: [], skipped: ['missing_phone_number_id'] })
  })

  it('rejects a number that is not digits, so it never reaches a query', () => {
    expect(parseWebhookPayload(webhook(textChange("1' or '1'='1", 'wamid.1', 'x'))).skipped).toEqual(['invalid_envelope'])
  })

  it('keeps the valid items of a batch when one is malformed', () => {
    const payload = webhook(
      change(PHONE_A, {
        messages: [
          { id: 'wamid.ok', from: '584121111111', timestamp: unix(new Date()), type: 'text', text: { body: 'ok' } },
          { id: '', from: 'not-digits', timestamp: 'x', type: 'text' },
        ],
      }),
    )
    const { events, skipped } = parseWebhookPayload(payload)
    expect(events.map(eventIdOf)).toEqual(['wamid.ok'])
    expect(skipped).toEqual(['invalid_message'])
  })

  it('ignores statuses Meta may add in the future', () => {
    expect(parseWebhookPayload(webhook(statusChange(PHONE_A, 'wamid.1', 'deleted'))).skipped).toEqual(['unknown_status'])
  })
})

describe('template status webhooks', () => {
  it('reads Meta reference example, routed by the WhatsApp Business Account', () => {
    const payload = templateStatusWebhook('102290129340398', {
      event: 'APPROVED',
      message_template_id: 1689556908129832,
      message_template_name: 'order_confirmation',
      message_template_language: 'en-US',
      reason: 'NONE',
      message_template_category: 'UTILITY',
    })
    expect(parseWebhookPayload(payload)).toEqual({
      events: [{ kind: 'template_status', wabaId: '102290129340398', metaTemplateId: '1689556908129832', event: 'APPROVED', reason: null }],
      skipped: [],
    })
  })

  it('keeps the detailed rejection reason when Meta gives one', () => {
    const payload = templateStatusWebhook('102290129340398', {
      event: 'REJECTED',
      message_template_id: 1689556908129835,
      reason: 'INVALID_FORMAT',
      rejection_info: { reason: 'Parameters placed next to each other', recommendation: 'Separate them' },
    })
    expect(parseWebhookPayload(payload).events[0]).toMatchObject({ event: 'REJECTED', reason: 'Parameters placed next to each other' })
  })

  it('skips it when the account id is not digits', () => {
    expect(parseWebhookPayload(templateStatusWebhook("1' or 1=1", { event: 'APPROVED', message_template_id: 1 })).skipped).toEqual([
      'invalid_template_status',
    ])
  })
})

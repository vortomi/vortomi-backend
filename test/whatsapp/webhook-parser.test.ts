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

describe('parseWebhookPayload: coexistence (the owner\'s WhatsApp Business app)', () => {
  const coex = (field: string, value: object) =>
    webhook({ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '584125550000', phone_number_id: PHONE_A }, ...value } })

  it('an echo without the customer\'s number (a username-only customer) is skipped, the rest kept', () => {
    const { events, skipped } = parseWebhookPayload(
      coex('smb_message_echoes', {
        message_echoes: [
          { from: '584125550000', id: 'wamid.e1', timestamp: '1790000000', type: 'text', text: { body: 'sin número' } },
          { from: '584125550000', to: '584125550111', id: 'wamid.e2', timestamp: '1790000000', type: 'image', image: { id: 'media-9', caption: 'la torta' } },
        ],
      }),
    )
    expect(skipped).toEqual(['invalid_echo'])
    expect(events).toEqual([
      expect.objectContaining({ kind: 'owner_echo', phoneNumberId: PHONE_A, waMessageId: 'wamid.e2', to: '584125550111', type: 'image', body: 'la torta', waMediaId: 'media-9' }),
    ])
  })

  it('contacts: phone numbers are normalised to digits; items without a number are skipped', () => {
    const { events, skipped } = parseWebhookPayload(
      coex('smb_app_state_sync', {
        state_sync: [
          { type: 'contact', contact: { full_name: 'Sra. María', phone_number: '+58 412-555 0111' }, action: 'add', metadata: { timestamp: '1790000000' } },
          { type: 'contact', contact: { full_name: 'Sin número' }, action: 'add', metadata: { timestamp: '1790000000' } },
        ],
      }),
    )
    expect(skipped).toEqual(['invalid_contact_sync'])
    expect(events).toEqual([{ kind: 'contact_sync', phoneNumberId: PHONE_A, contacts: [{ waId: '584125550111', fullName: 'Sra. María', action: 'add', timestamp: new Date(1790000000000) }] }])
  })
})

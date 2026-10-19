// Plays Meta against a running server: sends a webhook signed with META_APP_SECRET,
// exactly as Meta would, so the whole flow can be seen without a real number.
//
//   npm run meta:simulate -- message --phone-number-id 100000000000001 --from 584121234567 --text "Hola"
//   npm run meta:simulate -- status  --phone-number-id 100000000000001 --wamid wamid.XXX --status read
//   npm run meta:simulate -- template --waba-id 200000000000001 --template-id 9000001 --event APPROVED
//
// Target: http://localhost:$PORT/webhooks/whatsapp (override with --url). Development only:
// it refuses to run with NODE_ENV=production.
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const digits = z.string().regex(/^\d+$/)
const unix = () => String(Math.floor(Date.now() / 1000))

const changeFor = (phoneNumberId: string, value: object) => ({
  field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId }, ...value },
})

function payloadFor(kind: string, values: Record<string, string | undefined>): object {
  switch (kind) {
    case 'message': {
      const phoneNumberId = digits.parse(values['phone-number-id'])
      const from = digits.parse(values['from'])
      const text = z.string().min(1).parse(values['text'])
      const id = `wamid.sim.${randomUUID()}`
      return wrap(values['waba-id'] ?? '0', changeFor(phoneNumberId, {
        contacts: [{ wa_id: from, profile: { name: values['name'] ?? 'Cliente de prueba' } }],
        messages: [{ id, from, timestamp: unix(), type: 'text', text: { body: text } }],
      }))
    }
    case 'status': {
      const phoneNumberId = digits.parse(values['phone-number-id'])
      const status = z.enum(['sent', 'delivered', 'read', 'failed']).parse(values['status'])
      const id = z.string().min(1).parse(values['wamid'])
      return wrap(values['waba-id'] ?? '0', changeFor(phoneNumberId, { statuses: [{ id, status, timestamp: unix(), recipient_id: values['from'] ?? '0' }] }))
    }
    case 'template': {
      const wabaId = digits.parse(values['waba-id'])
      const templateId = Number(digits.parse(values['template-id']))
      const event = z.string().min(1).parse(values['event']).toUpperCase()
      return wrap(wabaId, { field: 'message_template_status_update', value: { event, message_template_id: templateId, reason: values['reason'] ?? 'NONE' } })
    }
    default:
      throw new Error('First argument must be: message, status or template')
  }
}

const wrap = (wabaId: string, change: object) => ({ object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [change] }] })

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  if (process.env.NODE_ENV === 'production') throw new Error('The simulator never runs against production')
  const secret = process.env.META_APP_SECRET
  if (!secret) throw new Error('META_APP_SECRET is missing in .env')

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      ['phone-number-id', 'waba-id', 'from', 'name', 'text', 'wamid', 'status', 'template-id', 'event', 'reason', 'url'].map((key) => [key, { type: 'string' as const }]),
    ),
  })
  const body = JSON.stringify(payloadFor(positionals[0] ?? '', values))
  const url = values['url'] ?? `http://localhost:${process.env.PORT ?? '3000'}/webhooks/whatsapp`
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body })
  // eslint-disable-next-line no-console
  console.log(`${response.status} ${response.statusText} <- ${url}`)
  if (!response.ok) process.exit(1)
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

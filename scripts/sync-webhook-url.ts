// Points Meta's webhook at a new public address, so nobody pastes it in the App Dashboard.
// Used by scripts/dev-tunnel.ps1 each time the development tunnel gets a new address.
//
//   npm run meta:webhook -- --url https://palabras-al-azar.trycloudflare.com
//
// Meta checks the address at once (GET with WEBHOOK_VERIFY_TOKEN), so the server must already
// answer there. Needs META_APP_ID, META_APP_SECRET and WEBHOOK_VERIFY_TOKEN in .env.
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const WEBHOOK_PATH = '/webhooks/whatsapp'
// What the server handles (src/modules/whatsapp/payload.schema.ts).
const FIELDS = 'messages,message_template_status_update'
const READY_TRIES = 20

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fresh tunnel can take a few seconds to answer: wait for our own health check through it. */
async function waitUntilReachable(base: string): Promise<void> {
  for (let i = 0; i < READY_TRIES; i++) {
    const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false)
    if (ok) return
    await sleep(3000)
  }
  throw new Error(`${base} does not answer; is the server running?`)
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const env = z
    .object({ META_APP_ID: z.string().regex(/^\d+$/), META_APP_SECRET: z.string().min(1), WEBHOOK_VERIFY_TOKEN: z.string().min(24) })
    .parse(process.env)
  const version = process.env.GRAPH_API_VERSION ?? 'v23.0'
  const { values } = parseArgs({ options: { url: { type: 'string' } }, strict: true })
  const base = z.url({ protocol: /^https$/ }).parse(values.url).replace(/\/+$/, '')

  await waitUntilReachable(base)
  const response = await fetch(`https://graph.facebook.com/${version}/${env.META_APP_ID}/subscriptions`, {
    method: 'POST',
    // The app token (id|secret) goes in a header, never in the URL or the logs.
    headers: { authorization: `Bearer ${env.META_APP_ID}|${env.META_APP_SECRET}` },
    body: new URLSearchParams({
      object: 'whatsapp_business_account',
      callback_url: `${base}${WEBHOOK_PATH}`,
      verify_token: env.WEBHOOK_VERIFY_TOKEN,
      fields: FIELDS,
    }),
  })
  const body = (await response.json()) as { success?: boolean; error?: { code?: number; message?: string } }
  if (!response.ok || !body.success) throw new Error(`Meta refused it (${response.status} ${body.error?.code ?? ''}): ${body.error?.message ?? 'no detail'}`)
  // eslint-disable-next-line no-console
  console.log(`Meta now sends to ${base}${WEBHOOK_PATH}`)
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

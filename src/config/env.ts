import { z } from 'zod'

/**
 * Runtime configuration. Validated once at boot: a missing secret must stop
 * the server, never degrade into an unverified webhook endpoint.
 * There is no phone number here: numbers belong to companies and live in the
 * database (channel_accounts), routed by phone_number_id.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  // Supabase Auth issues the panel sessions; its public keys verify them (no secret needed).
  SUPABASE_URL: z.url({ protocol: /^https$/ }),

  // 32 random bytes, base64. Encrypts each number's access token at rest. Losing it
  // means re-entering every token; leaking it exposes them only with a database copy.
  CREDENTIALS_ENCRYPTION_KEY: z.base64().refine((value) => Buffer.from(value, 'base64').length === 32, '32 bytes, base64'),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),

  // One app, one webhook endpoint for every company: these two are platform secrets.
  META_APP_SECRET: z.string().min(16),
  // Invented by us and typed into Meta when subscribing the webhook.
  WEBHOOK_VERIFY_TOKEN: z.string().min(24),

  // How often the BCV rate is read for the companies that use it: 1 hour; 0 turns it off.
  BCV_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),

  // The sales agent's model (Google Gemini). Without a key the agent stays off for everyone,
  // whatever each company chose. Free tier while testing: it uses the data to improve Google's
  // products, so real customers need the paid tier.
  GEMINI_API_KEY: z.string().min(20).optional(),
  AGENT_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.5-flash-lite'),
  // Answers per company and month; past it the conversations go to a person. 0 = no answers.
  AGENT_MONTHLY_REPLY_CAP: z.coerce.number().int().min(0).max(1_000_000).default(1000),
})

export type Env = z.infer<typeof envSchema>

export class EnvValidationError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`)
    this.name = 'EnvValidationError'
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  // prettifyError lists field names and rules, never the offending values.
  if (!parsed.success) throw new EnvValidationError(z.prettifyError(parsed.error))
  return parsed.data
}

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

  // One webhook endpoint for every company: these are platform secrets.
  META_APP_SECRET: z.string().min(16),
  // Secrets of other Meta apps of the platform that share the webhook (e.g. the published app
  // while numbers still live on the test one). Comma-separated; empty or unset when there is one app.
  META_ADDITIONAL_APP_SECRETS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((secret) => secret.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(16)).max(4)),
  // Invented by us and typed into Meta when subscribing the webhook.
  WEBHOOK_VERIFY_TOKEN: z.string().min(24),

  // «Conectar WhatsApp» (Meta's Embedded Signup): the published app a company connects its number
  // to, and its Facebook Login for Business configuration. The id and configuration are public (the
  // panel gets them); the secret only exchanges the code Meta hands the panel. All three or none:
  // without them the button is not offered and numbers are connected from the console.
  META_SIGNUP_APP_ID: z.string().regex(/^\d{5,25}$/).optional(),
  META_SIGNUP_APP_SECRET: z.string().min(16).optional(),
  META_SIGNUP_CONFIG_ID: z.string().regex(/^\d{5,25}$/).optional(),

  // How often the BCV rate is read for the companies that use it: 1 hour; 0 turns it off.
  BCV_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),

  // The sales agent's model (Google Gemini). Without a key the agent stays off for everyone,
  // whatever each company chose. Free tier while testing: it uses the data to improve Google's
  // products, so real customers need the paid tier.
  GEMINI_API_KEY: z.string().min(20).optional(),
  AGENT_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.5-flash-lite'),
  // Answers per company and month; past it the conversations go to a person. 0 = no answers.
  AGENT_MONTHLY_REPLY_CAP: z.coerce.number().int().min(0).max(1_000_000).default(1000),
}).refine(
  (env) => [env.META_SIGNUP_APP_ID, env.META_SIGNUP_APP_SECRET, env.META_SIGNUP_CONFIG_ID].filter(Boolean).length % 3 === 0,
  { message: 'META_SIGNUP_APP_ID, META_SIGNUP_APP_SECRET and META_SIGNUP_CONFIG_ID go together', path: ['META_SIGNUP_APP_ID'] },
)

/** The Embedded Signup settings, when all three are set. */
export function signupSettings(env: Env): { appId: string; appSecret: string; configId: string } | null {
  const { META_SIGNUP_APP_ID: appId, META_SIGNUP_APP_SECRET: appSecret, META_SIGNUP_CONFIG_ID: configId } = env
  return appId && appSecret && configId ? { appId, appSecret, configId } : null
}

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

import { randomBytes } from 'node:crypto'
import { z } from 'zod'

/** Supabase refused the password as too weak (its own policy, beyond ours). */
export class WeakPasswordError extends Error {
  constructor() {
    super('The password is too weak')
    this.name = 'WeakPasswordError'
  }
}

/**
 * The rule of the Supabase project (Authentication → Sign In / Providers → Email): 8 or more
 * characters, with letters and digits. 72 is bcrypt's limit: anything longer would be cut.
 */
export const newPassword = z
  .string()
  .min(8)
  .max(72)
  .regex(/\p{L}/u)
  .regex(/\d/)

/** A password nobody knows: what an account has between a link being given and being used. */
export const unknownPassword = () => `${randomBytes(30).toString('base64url')}a1`

/** Sets a person's password in Supabase Auth, which keeps them (never our tables). */
export interface AccountPasswords {
  set(userId: string, password: string): Promise<void>
}

/**
 * Supabase Auth's admin API with the project's secret key (sb_secret_..., env SUPABASE_SECRET_KEY),
 * sent in the apikey header only: the gateway accepts it there. Neither the key nor the password is
 * ever logged; a refusal says only its status.
 */
export class SupabaseAccountPasswords implements AccountPasswords {
  constructor(
    private readonly supabaseUrl: string,
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async set(userId: string, password: string): Promise<void> {
    const response = await this.fetchFn(`${this.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { apikey: this.secretKey, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return
    if (response.status === 422) {
      const body = (await response.json().catch(() => null)) as { error_code?: string; code?: string } | null
      if (body?.error_code === 'weak_password' || body?.code === 'weak_password') throw new WeakPasswordError()
    }
    throw new Error(`Supabase Auth refused the password change (${response.status})`)
  }
}

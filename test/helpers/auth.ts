import { randomUUID } from 'node:crypto'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import type { Database } from '../../src/db/client.ts'
import type { MemberRole, MembershipStatus, PlatformRole } from '../../src/db/schema/enums.ts'
import { conversationAssignees, conversations, membershipChannels, memberships, users } from '../../src/db/schema/index.ts'
import { SupabaseTokenVerifier } from '../../src/modules/access/supabase-token-verifier.ts'

/** Stands in for a Supabase project: its URL and one ES256 signing key, like the real JWKS. */
export const SUPABASE_URL = 'https://testproject.supabase.co'
export const ISSUER = `${SUPABASE_URL}/auth/v1`

const KEY_ID = 'test-key'
const { privateKey, publicKey } = await generateKeyPair('ES256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'ES256', use: 'sig' }] })

export const testVerifier = () => new SupabaseTokenVerifier(SUPABASE_URL, jwks)

export interface TokenOptions {
  email?: string
  aal?: 'aal1' | 'aal2'
  issuer?: string
  audience?: string
  role?: string
  expiresIn?: string
}

/** A Supabase-shaped access token for `userId`, signed with the test project's key. */
export async function tokenFor(userId: string, options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: options.email ?? `${userId.slice(0, 8)}@example.com`, role: options.role ?? 'authenticated', aal: options.aal ?? 'aal1' })
    .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
    .setSubject(userId)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(privateKey)
}

export const bearer = async (userId: string, options?: TokenOptions) => ({ authorization: `Bearer ${await tokenFor(userId, options)}` })

/** Creates a person the way accepting an invitation will (server role). */
export async function seedUser(db: Database, name: string, platformRole: PlatformRole | null = null): Promise<string> {
  const id = randomUUID()
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`
  await db.insert(users).values({ id, email, name, platformRole })
  return id
}

export interface MemberOptions {
  role?: MemberRole
  status?: MembershipStatus
  canSeeOthers?: boolean
  channelAccountIds?: string[]
}

export async function seedMembership(db: Database, tenantId: string, userId: string, options: MemberOptions = {}): Promise<void> {
  const role = options.role ?? 'agent'
  await db.insert(memberships).values({
    tenantId,
    userId,
    role,
    status: options.status ?? 'active',
    canSeeOthers: options.canSeeOthers ?? role === 'admin',
  })
  for (const channelAccountId of options.channelAccountIds ?? []) {
    await db.insert(membershipChannels).values({ tenantId, userId, channelAccountId })
  }
}

/** Puts people in charge of a conversation, straight in the database (admins do it through the API). */
export async function seedAssignees(db: Database, tenantId: string, conversationId: string, ...userIds: string[]): Promise<void> {
  await db.insert(conversationAssignees).values(userIds.map((userId) => ({ tenantId, conversationId, userId })))
}

/** A conversation for a contact typed by hand, attended by those people: what lets an agent see the contact. */
export async function seedConversationFor(db: Database, tenantId: string, contactId: string, ...userIds: string[]): Promise<string> {
  const [row] = await db.insert(conversations).values({ tenantId, contactId }).returning({ id: conversations.id })
  if (userIds.length) await seedAssignees(db, tenantId, row!.id, ...userIds)
  return row!.id
}

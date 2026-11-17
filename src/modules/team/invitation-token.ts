import { createHash, randomBytes } from 'node:crypto'

/** How long an invitation link works (documentations/03): company and console invitations alike. */
export const INVITATION_TTL_MS = 72 * 3_600_000

/** The link token: 256 random bits. Only its hash is stored. */
export const newToken = () => randomBytes(32).toString('base64url')
export const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
export const invitationExpiry = () => new Date(Date.now() + INVITATION_TTL_MS)

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { type AppDependencies, buildApp } from '../../src/app.ts'
import type { Database } from '../../src/db/client.ts'
import { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { CredentialCipher } from '../../src/modules/channels/credential-cipher.ts'
import { type TemplateMessage, type TemplateRegistry, type TemplateSubmission, type TextMessage, WhatsAppApiError, type WhatsAppSender } from '../../src/modules/whatsapp/cloud-api.client.ts'
import { testVerifier } from './auth.ts'
import { APP_SECRET, VERIFY_TOKEN } from './meta-payloads.ts'

/** Stands in for Meta: records every message and answers what the test tells it to. */
export class FakeSender implements WhatsAppSender {
  readonly sent: (TextMessage | TemplateMessage)[] = []
  private next: (() => Promise<{ waMessageId: string }>) | null = null

  failNextWith(code: number, message = 'Rejected by Meta'): void {
    this.next = () => Promise.reject(new WhatsAppApiError(message, 400, code))
  }

  sendTemplate(message: TemplateMessage): Promise<{ waMessageId: string }> {
    return this.sendText(message)
  }

  sendText(message: TextMessage | TemplateMessage): Promise<{ waMessageId: string }> {
    this.sent.push(message)
    const answer = this.next
    this.next = null
    return answer ? answer() : Promise.resolve({ waMessageId: `wamid.out.${this.sent.length}` })
  }
}

/** Stands in for Meta's template review: accepts every submission as PENDING. */
export class FakeRegistry implements TemplateRegistry {
  readonly submitted: TemplateSubmission[] = []

  submitTemplate(submission: TemplateSubmission): Promise<{ metaTemplateId: string; status: string }> {
    this.submitted.push(submission)
    return Promise.resolve({ metaTemplateId: String(9_000_000 + this.submitted.length), status: 'PENDING' })
  }
}

export const testCredentials = (db: Database) => new ChannelCredentials(db, new CredentialCipher(randomBytes(32).toString('base64')))

/** The real app with test doubles only at the edges: Supabase keys, Meta, the credential key. */
export function buildTestApp(db: Database, overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  return buildApp(
    {
      db,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      onVerifiedPayload: () => Promise.resolve(),
      tokenVerifier: testVerifier(),
      credentials: testCredentials(db),
      sender: new FakeSender(),
      templateRegistry: new FakeRegistry(),
      ...overrides,
    },
    false,
  )
}

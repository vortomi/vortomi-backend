import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { type AppDependencies, buildApp } from '../../src/app.ts'
import type { Database } from '../../src/db/client.ts'
import { ChannelCredentials } from '../../src/modules/channels/channel-credentials.ts'
import { CredentialCipher } from '../../src/modules/channels/credential-cipher.ts'
import {
  type AppDataSync,
  type ImageMessage,
  type NumberDetails,
  type TemplateMessage,
  type TemplateRegistry,
  type TemplateSubmission,
  type TextMessage,
  type WabaDirectory,
  type WabaNumber,
  WhatsAppApiError,
  type WhatsAppSender,
} from '../../src/modules/whatsapp/cloud-api.client.ts'
import type { BcvRate } from '../../src/modules/exchange-rates/bcv-page.ts'
import { BcvRateService } from '../../src/modules/exchange-rates/bcv-rate.service.ts'
import { BcvReadError, type BcvSource } from '../../src/modules/exchange-rates/bcv-source.ts'
import { InboxFeed } from '../../src/modules/realtime/inbox-feed.ts'
import { testVerifier } from './auth.ts'
import { APP_SECRET, VERIFY_TOKEN } from './meta-payloads.ts'

/** Ids never repeat across senders of a test file: Meta's ids are unique, and messages keep them. */
let sentCounter = 0

/** Stands in for Meta: records every message and answers what the test tells it to. */
export class FakeSender implements WhatsAppSender {
  readonly sent: (TextMessage | TemplateMessage | ImageMessage)[] = []
  private next: (() => Promise<{ waMessageId: string }>) | null = null

  failNextWith(code: number, message = 'Rejected by Meta'): void {
    this.next = () => Promise.reject(new WhatsAppApiError(message, 400, code))
  }

  sendTemplate(message: TemplateMessage): Promise<{ waMessageId: string }> {
    return this.sendText(message)
  }

  sendImage(message: ImageMessage): Promise<{ waMessageId: string }> {
    return this.sendText(message)
  }

  sendText(message: TextMessage | TemplateMessage | ImageMessage): Promise<{ waMessageId: string }> {
    this.sent.push(message)
    const answer = this.next
    this.next = null
    return answer ? answer() : Promise.resolve({ waMessageId: `wamid.out.${++sentCounter}` })
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

/** Stands in for Meta's account directory: the numbers a test puts in each account. */
export class FakeWabaDirectory implements WabaDirectory {
  readonly accounts = new Map<string, WabaNumber[]>()
  readonly subscribed: string[] = []

  /** Accounts for which Meta answers with this Graph error code (190 bad token, 200 no permission...). */
  readonly refusals = new Map<string, number>()

  listNumbers(wabaId: string): Promise<WabaNumber[]> {
    const refusal = this.refusals.get(wabaId)
    if (refusal) return Promise.reject(new WhatsAppApiError('Cloud API rejected the request (400): refused', 400, refusal))
    const numbers = this.accounts.get(wabaId)
    return numbers ? Promise.resolve(numbers) : Promise.reject(new WhatsAppApiError('Unknown account', 400, 100))
  }

  /** Meta's business verification per account; an account without one answers null (Meta did not say). */
  readonly verification = new Map<string, string>()

  businessVerification(wabaId: string): Promise<string | null> {
    return Promise.resolve(this.verification.get(wabaId) ?? null)
  }

  subscribeApp(wabaId: string): Promise<void> {
    this.subscribed.push(wabaId)
    return Promise.resolve()
  }

  /** Numbers that also live on the owner's WhatsApp Business app (coexistence). */
  readonly onBusinessApp = new Set<string>()
  readonly registered: { phoneNumberId: string; pin: string }[] = []
  readonly syncs: { phoneNumberId: string; kind: AppDataSync }[] = []

  numberDetails(phoneNumberId: string): Promise<NumberDetails> {
    const number = [...this.accounts.values()].flat().find((n) => n.phoneNumberId === phoneNumberId)
    if (!number) return Promise.reject(new WhatsAppApiError('Unknown number', 400, 100))
    return Promise.resolve({ displayNumber: number.displayNumber, verifiedName: number.verifiedName, onBusinessApp: this.onBusinessApp.has(phoneNumberId) })
  }

  registerNumber(phoneNumberId: string, _accessToken: string, pin: string): Promise<void> {
    this.registered.push({ phoneNumberId, pin })
    return Promise.resolve()
  }

  requestAppDataSync(phoneNumberId: string, _accessToken: string, kind: AppDataSync): Promise<void> {
    this.syncs.push({ phoneNumberId, kind })
    return Promise.resolve()
  }
}

/** Stands in for bcv.org.ve: answers `next`, a rate or the reason it could not be read. */
export class FakeBcvSource implements BcvSource {
  next: BcvRate | string = 'la página del BCV no respondió.'
  reads = 0

  read(): Promise<BcvRate> {
    this.reads++
    return typeof this.next === 'string' ? Promise.reject(new BcvReadError(this.next)) : Promise.resolve(this.next)
  }
}

export const silentLog = { error: () => undefined, warn: () => undefined }

export const testCredentials = (db: Database) => new ChannelCredentials(db, new CredentialCipher(randomBytes(32).toString('base64')))

/** The real app with test doubles only at the edges: Supabase keys, Meta, the credential key. */
export function buildTestApp(db: Database, overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  return buildApp(
    {
      db,
      verifyToken: VERIFY_TOKEN,
      appSecrets: [APP_SECRET],
      onVerifiedPayload: () => Promise.resolve(),
      tokenVerifier: testVerifier(),
      credentials: testCredentials(db),
      sender: new FakeSender(),
      templateRegistry: new FakeRegistry(),
      wabaDirectory: new FakeWabaDirectory(),
      feed: new InboxFeed(),
      bcv: new BcvRateService(db, new FakeBcvSource(), silentLog),
      ...overrides,
    },
    false,
  )
}

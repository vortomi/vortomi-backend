import { CHAT_MEDIA_KINDS, type ChatMediaKind, messageMedia } from '../../db/schema/index.ts'
import type { TenantScope } from '../tenancy/tenant-scope.ts'
import type { MessageContent } from '../whatsapp/events.ts'

/** A stored message whose file Vortomi may keep a copy of. */
export interface MediaNote {
  messageId: number
  content: Pick<MessageContent, 'type' | 'waMediaId' | 'fileName'>
}

const isKept = (type: string): type is ChatMediaKind => (CHAT_MEDIA_KINDS as readonly string[]).includes(type)

/**
 * Notes, in the same transaction as the message, that its file is waiting to be copied (status
 * pending): the archiver does the copy later, outside any webhook. Videos and messages without a
 * file are not noted. Repeating it for the same message changes nothing.
 */
export async function noteMedia(scope: TenantScope, notes: MediaNote[]): Promise<void> {
  const rows = notes.flatMap(({ messageId, content }) =>
    content.waMediaId && isKept(content.type)
      ? [{ tenantId: scope.tenantId, messageId, kind: content.type, fileName: content.type === 'document' ? (content.fileName ?? null) : null }]
      : [],
  )
  if (rows.length) await scope.tx.insert(messageMedia).values(rows).onConflictDoNothing()
}

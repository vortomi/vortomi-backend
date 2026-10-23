import { NotAMemberError } from '../modules/access/member-scope.ts'
import { CategoryNotFoundError } from '../modules/inventory/category-service.ts'
import { InventoryNotFoundError, MovementNotAllowedError } from '../modules/inventory/inventory-service.ts'
import { ContactNotFoundError, UnknownTagError } from '../modules/contacts/contact-service.ts'
import { TagNotFoundError } from '../modules/contacts/tag-service.ts'
import { AssigneeCannotAttendError, ConversationNotFoundError, MentionNotMemberError } from '../modules/conversations/conversation-commands.ts'
import { ConcurrentSendError, ServiceWindowClosedError, TemplateNotUsableError } from '../modules/messaging/outbound.service.ts'
import { InvalidTemplateError } from '../modules/templates/template-body.ts'
import { TemplateAdminRequiredError } from '../modules/templates/template-service.ts'
import { StageNotFoundError } from '../modules/workspace/pipeline-service.ts'
import { QuickReplyNotFoundError } from '../modules/workspace/quick-reply-service.ts'
import { ApiError } from './errors.ts'

type ErrorClass = new (...args: never[]) => Error

/**
 * Domain errors -> API answers, in one place. Modules throw meaningful errors and
 * know nothing about HTTP; "not found" and "not visible to you" share one answer.
 */
const DOMAIN_ERRORS: [ErrorClass, ApiError['statusCode'], string][] = [
  [NotAMemberError, 403, 'not_a_member'],
  [TemplateAdminRequiredError, 403, 'admin_required'],
  [MovementNotAllowedError, 403, 'admin_required'],
  [InventoryNotFoundError, 404, 'inventory_item_not_found'],
  [CategoryNotFoundError, 404, 'category_not_found'],
  [ConversationNotFoundError, 404, 'conversation_not_found'],
  [ContactNotFoundError, 404, 'contact_not_found'],
  [TagNotFoundError, 404, 'tag_not_found'],
  [QuickReplyNotFoundError, 404, 'quick_reply_not_found'],
  [StageNotFoundError, 404, 'stage_not_found'],
  [AssigneeCannotAttendError, 422, 'assignee_cannot_attend'],
  [MentionNotMemberError, 422, 'mention_not_member'],
  [UnknownTagError, 422, 'unknown_tag'],
  [ServiceWindowClosedError, 422, 'service_window_closed'],
  [TemplateNotUsableError, 422, 'template_not_usable'],
  [InvalidTemplateError, 422, 'invalid_template'],
  [ConcurrentSendError, 409, 'send_in_progress'],
]

/** Constraint violations the client can act on, by constraint name. */
const CONSTRAINT_CONFLICTS: Record<string, string> = {
  tags_tenant_name_key: 'tag_name_taken',
  quick_replies_tenant_shortcut_key: 'shortcut_taken',
  pipeline_stages_tenant_name_key: 'stage_name_taken',
  contacts_stage_fk: 'stage_in_use',
  message_templates_tenant_waba_name_language_key: 'template_exists',
  product_variants_tenant_sku_key: 'sku_taken',
  product_categories_tenant_name_key: 'category_name_taken',
  products_category_fk: 'category_in_use',
  product_variants_stock_check: 'insufficient_stock',
  stock_movements_sign_check: 'invalid_movement',
}
// 23505 unique, 23503 foreign key, 23514 check.
const CONFLICT_CODES = new Set(['23505', '23503', '23514'])

export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error
  for (const [type, status, code] of DOMAIN_ERRORS) {
    if (error instanceof type) return new ApiError(status, code, error.message)
  }
  // Drizzle wraps the driver error; the Postgres code and constraint are on the cause.
  const cause = (error as { cause?: { code?: string; constraint?: string; constraint_name?: string } } | null)?.cause
  const constraint = cause?.constraint ?? cause?.constraint_name
  const conflict = constraint ? CONSTRAINT_CONFLICTS[constraint] : undefined
  if (cause?.code && CONFLICT_CODES.has(cause.code) && conflict) return new ApiError(409, conflict)
  return null
}

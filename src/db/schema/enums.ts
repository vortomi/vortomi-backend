/**
 * Allowed values for every text column constrained by a CHECK in the database.
 * Single source of truth: the schema builds its CHECK constraints from these
 * arrays and the application derives its types from them.
 */

export const TENANT_STATUSES = ['draft', 'awaiting_channel', 'active', 'suspended', 'cancelled'] as const
export type TenantStatus = (typeof TENANT_STATUSES)[number]

export const TENANT_PLANS = ['internal', 'basic', 'team'] as const
export type TenantPlan = (typeof TENANT_PLANS)[number]

export const CHANNEL_STATUSES = ['connected', 'disconnected', 'restricted'] as const
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number]

export const CONVERSATION_STATUSES = ['open', 'resolved'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

/** owner_app = written from the WhatsApp Business app on a coexistence number. */
export const MESSAGE_AUTHORS = ['customer', 'staff', 'bot', 'owner_app'] as const
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number]

export const MESSAGE_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'template',
  'unsupported',
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

/** What Meta reports about an outbound message, in the order it can only move forward. */
export const DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** Our own team. Required second factor (aal2) to reach the platform console. */
export const PLATFORM_ROLES = ['super_admin'] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

/** admin: whole company, team and settings. agent: the numbers assigned to them. */
export const MEMBER_ROLES = ['admin', 'agent'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** invited: link sent, not accepted yet. disabled: left the team; kept for history and assignments. */
export const MEMBERSHIP_STATUSES = ['invited', 'active', 'disabled'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/** Colour of a tag in the panel (same palette as the prototype). */
export const TAG_TONES = ['green', 'red', 'amber', 'blue', 'violet', 'neutral', 'pink', 'teal'] as const
export type TagTone = (typeof TAG_TONES)[number]

/** sales_and_support: the default, nothing to configure. support_only hides pipeline and inventory. */
export const WORK_MODES = ['sales_and_support', 'support_only'] as const
export type WorkMode = (typeof WORK_MODES)[number]

export const TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** draft: stored, not accepted by Meta yet (or its submission failed). The rest mirror Meta's review. */
export const TEMPLATE_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled'] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

/** availability: an on/off switch (made to order, services). units: counted stock. */
export const STOCK_MODES = ['availability', 'units'] as const
export type StockMode = (typeof STOCK_MODES)[number]

/** Every stock change is one of these. Sign is fixed by kind (stock_movements_sign_check). */
export const STOCK_MOVEMENT_KINDS = ['initial', 'purchase', 'sale', 'adjustment', 'loss', 'return'] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

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

/** bcv: read from the Banco Central de Venezuela every hour. custom: typed by an admin. */
export const RATE_SOURCES = ['bcv', 'custom'] as const
export type RateSource = (typeof RATE_SOURCES)[number]

/** Where one row of a company's rate history came from. */
export const RATE_ORIGINS = ['bcv', 'manual'] as const
export type RateOrigin = (typeof RATE_ORIGINS)[number]

/** availability: an on/off switch (made to order, services). units: counted stock. */
export const STOCK_MODES = ['availability', 'units'] as const
export type StockMode = (typeof STOCK_MODES)[number]

/**
 * How a product is sold: its price is per one of these and quantities count in it. A closed
 * list kept by the platform (companies pick, never type). Pieces, grams and visits count
 * whole; weight, length, area, volume and hours take up to 2 decimals (DECIMAL_SALE_UNITS).
 */
export const SALE_UNITS = ['unit', 'pair', 'dozen', 'box', 'pack', 'roll', 'kg', 'g', 'm', 'm2', 'l', 'hour', 'service', 'session'] as const
export type SaleUnit = (typeof SALE_UNITS)[number]
export const DECIMAL_SALE_UNITS: readonly SaleUnit[] = ['kg', 'm', 'm2', 'l', 'hour']
/** Units counted one by one (3 boxes are 3); the rest (kilos, grams, visits...) count once per product. */
export const PIECE_SALE_UNITS: readonly SaleUnit[] = ['unit', 'pair', 'dozen', 'box', 'pack', 'roll']

/** What a company sells, as it answers the welcome (block C). none: it only attends customers. */
export const SELLS = ['products', 'services', 'both', 'none'] as const
export type Sells = (typeof SELLS)[number]

/** How it usually sells: by the unit, by weight, by length or volume, by time, or mixed. */
export const SELL_METHODS = ['unit', 'weight', 'measure', 'time', 'mixed'] as const
export type SellMethod = (typeof SELL_METHODS)[number]

/** Whose data a company field describes: its products or its customers. */
export const CUSTOM_FIELD_ENTITIES = ['product', 'contact'] as const
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number]

/**
 * How a company field is answered (closed list): short text, a number, one or several choices
 * of the field's own list, yes or no, or a date.
 */
export const CUSTOM_FIELD_KINDS = ['text', 'number', 'choice', 'multi_choice', 'boolean', 'date'] as const
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number]

/** Every stock change is one of these. Sign is fixed by kind (stock_movements_sign_check). */
export const STOCK_MOVEMENT_KINDS = ['initial', 'purchase', 'sale', 'adjustment', 'loss', 'return'] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

/** How the sales agent writes (closed list; the prompt spells each one out). */
export const AGENT_TONES = ['friendly', 'formal', 'brief'] as const
export type AgentTone = (typeof AGENT_TONES)[number]

/** When the sales agent answers: all the time, or only while the company is closed. */
export const AGENT_SCHEDULES = ['always', 'after_hours'] as const
export type AgentSchedule = (typeof AGENT_SCHEDULES)[number]

/** Why a conversation was passed from the agent to a person ('purchase': orders are taken by people, for now). */
export const HANDOFF_REASONS = ['customer_asked', 'purchase', 'order_placed', 'agent_unsure', 'agent_error', 'limit_reached'] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

/**
 * A company's own system the agent reads its catalog from, instead of Vortomi's inventory
 * (closed list: one adapter per system, modules/catalog-source).
 */
export const CATALOG_SOURCE_KINDS = ['lacampina_v1'] as const
export type CatalogSourceKind = (typeof CATALOG_SOURCE_KINDS)[number]

/** How a company charges delivery: one price everywhere, or a price per zone it names. */
export const DELIVERY_MODES = ['flat', 'zones'] as const
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

/** What that price is for: the whole order (one trip), or each piece ordered (3 jugs pay it 3 times). */
export const DELIVERY_CHARGES = ['per_order', 'per_piece'] as const
export type DeliveryCharge = (typeof DELIVERY_CHARGES)[number]

/**
 * Where an order stands: waiting for the customer's payment, payment receipt to review, confirmed
 * by a person (the customer is told), done (delivered or picked up) or cancelled.
 */
export const ORDER_STATUSES = ['awaiting_payment', 'payment_review', 'confirmed', 'done', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** Who makes an order's sale receipt: Vortomi, the team (its own image), or nobody. */
export const RECEIPT_MODES = ['vortomi', 'own', 'off'] as const
export type ReceiptMode = (typeof RECEIPT_MODES)[number]

export const FULFILLMENTS = ['pickup', 'delivery'] as const
export type Fulfillment = (typeof FULFILLMENTS)[number]

/**
 * Kinds of payment method a company offers (Ajustes → Métodos de pago). The kind sets the currency
 * the customer pays in and the data suggested for it; the company writes the data itself.
 */
export const PAYMENT_METHOD_TYPES = ['pago_movil', 'transfer_national', 'zelle', 'paypal', 'binance', 'transfer_international', 'cash_usd', 'cash_ves', 'cash_eur', 'arrange'] as const
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number]

/** What a datum of a payment method is, for its editor and its format check. */
export const PAYMENT_FIELD_KINDS = ['text', 'bank', 'document', 'phone'] as const
export type PaymentFieldKind = (typeof PAYMENT_FIELD_KINDS)[number]

/** Whether the customer must send the payment reference or the receipt. */
export const PAYMENT_PROOF_RULES = ['required', 'optional', 'none'] as const
export type PaymentProofRule = (typeof PAYMENT_PROOF_RULES)[number]

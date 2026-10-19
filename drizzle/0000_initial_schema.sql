CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"display_name" text,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "contacts_tenant_channel_wa_id_key" UNIQUE("tenant_id","channel_account_id","wa_id"),
	CONSTRAINT "contacts_wa_id_check" CHECK ("contacts"."wa_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversations_tenant_contact_key" UNIQUE("tenant_id","contact_id"),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "message_status_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"wa_message_id" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"pricing_category" text,
	"billable" boolean,
	"error_text" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_status_events_dedup_key" UNIQUE("tenant_id","wa_message_id","status"),
	CONSTRAINT "message_status_events_status_check" CHECK ("message_status_events"."status" in ('sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"wa_message_id" text,
	"direction" text NOT NULL,
	"author" text NOT NULL,
	"type" text NOT NULL,
	"body" text,
	"wa_media_id" text,
	"wa_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_tenant_wa_message_id_key" UNIQUE("tenant_id","wa_message_id"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('in', 'out')),
	CONSTRAINT "messages_author_check" CHECK ("messages"."author" in ('customer', 'staff', 'bot', 'owner_app')),
	CONSTRAINT "messages_type_check" CHECK ("messages"."type" in ('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'button', 'reaction', 'template', 'unsupported')),
	CONSTRAINT "messages_author_direction_check" CHECK (("messages"."direction" = 'in') = ("messages"."author" = 'customer'))
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_number" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_accounts_phone_number_id_unique" UNIQUE("phone_number_id"),
	CONSTRAINT "channel_accounts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_accounts_status_check" CHECK ("channel_accounts"."status" in ('connected', 'disconnected', 'restricted')),
	CONSTRAINT "channel_accounts_phone_number_id_check" CHECK ("channel_accounts"."phone_number_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"plan" text NOT NULL,
	"timezone" text DEFAULT 'America/Caracas' NOT NULL,
	"legal_name" text NOT NULL,
	"tax_id" text NOT NULL,
	"fiscal_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('draft', 'awaiting_channel', 'active', 'suspended', 'cancelled')),
	CONSTRAINT "tenants_plan_check" CHECK ("tenants"."plan" in ('internal', 'basic', 'team')),
	CONSTRAINT "tenants_tax_id_check" CHECK ("tenants"."tax_id" ~ '^[JVEGPC]-[0-9]{8}-[0-9]$')
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "webhook_events_attempts_check" CHECK ("webhook_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_channel_fk" FOREIGN KEY ("tenant_id","channel_account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_tenant_activity_idx" ON "conversations" USING btree ("tenant_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_accounts_tenant_idx" ON "channel_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_events_pending_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;
CREATE TABLE "agent_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"assistant_name" text DEFAULT 'Asistente' NOT NULL,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"schedule" text DEFAULT 'always' NOT NULL,
	"business_info" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_settings_tone_check" CHECK ("agent_settings"."tone" in ('friendly', 'formal', 'brief')),
	CONSTRAINT "agent_settings_schedule_check" CHECK ("agent_settings"."schedule" in ('always', 'after_hours')),
	CONSTRAINT "agent_settings_assistant_name_check" CHECK (length("agent_settings"."assistant_name") between 1 and 40),
	CONSTRAINT "agent_settings_business_info_check" CHECK (length("agent_settings"."business_info") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"tenant_id" uuid NOT NULL,
	"month" date NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_usage_pkey" PRIMARY KEY("tenant_id","month"),
	CONSTRAINT "agent_usage_counts_check" CHECK ("agent_usage"."replies" >= 0 and "agent_usage"."input_tokens" >= 0 and "agent_usage"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_check" CHECK (("conversations"."handoff_at" is null) = ("conversations"."handoff_reason" is null));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_reason_check" CHECK ("conversations"."handoff_reason" in ('customer_asked', 'purchase', 'agent_unsure', 'agent_error', 'limit_reached'));
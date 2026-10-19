CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pipeline_stages_color_check" CHECK ("pipeline_stages"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "pipeline_stages_position_check" CHECK ("pipeline_stages"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_shortcut_check" CHECK ("quick_replies"."shortcut" ~ '^[a-z0-9_-]{1,30}$'),
	CONSTRAINT "quick_replies_body_check" CHECK (length(trim("quick_replies"."body")) between 1 and 4096)
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"work_mode" text DEFAULT 'sales_and_support' NOT NULL,
	"business_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"away_message" text DEFAULT '' NOT NULL,
	"exchange_rate_ves" numeric(14, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_settings_work_mode_check" CHECK ("tenant_settings"."work_mode" in ('sales_and_support', 'support_only')),
	CONSTRAINT "tenant_settings_business_hours_check" CHECK (jsonb_typeof("tenant_settings"."business_hours") = 'array'),
	CONSTRAINT "tenant_settings_away_message_check" CHECK (length("tenant_settings"."away_message") <= 1024),
	CONSTRAINT "tenant_settings_exchange_rate_check" CHECK ("tenant_settings"."exchange_rate_ves" is null or "tenant_settings"."exchange_rate_ves" > 0)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "quote_cents" integer;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_tenant_name_key" ON "pipeline_stages" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_tenant_shortcut_key" ON "quick_replies" USING btree ("tenant_id",lower("shortcut"));--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_stage_fk" FOREIGN KEY ("tenant_id","stage_id") REFERENCES "public"."pipeline_stages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_quote_check" CHECK ("contacts"."quote_cents" is null or "contacts"."quote_cents" >= 0);
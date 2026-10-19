CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"meta_template_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_reason" text,
	"submit_error" text,
	"body" text NOT NULL,
	"body_example" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_templates_tenant_waba_name_language_key" UNIQUE("tenant_id","waba_id","name","language"),
	CONSTRAINT "message_templates_tenant_meta_id_key" UNIQUE("tenant_id","meta_template_id"),
	CONSTRAINT "message_templates_name_check" CHECK ("message_templates"."name" ~ '^[a-z0-9_]+$' and length("message_templates"."name") <= 512),
	CONSTRAINT "message_templates_language_check" CHECK ("message_templates"."language" ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
	CONSTRAINT "message_templates_body_check" CHECK (length("message_templates"."body") between 1 and 1024),
	CONSTRAINT "message_templates_category_check" CHECK ("message_templates"."category" in ('utility', 'marketing', 'authentication')),
	CONSTRAINT "message_templates_status_check" CHECK ("message_templates"."status" in ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."message_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;
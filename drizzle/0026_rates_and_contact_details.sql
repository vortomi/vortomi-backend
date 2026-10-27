CREATE TABLE "bcv_status" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"rate" numeric(18, 8),
	"effective_date" date,
	"checked_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "bcv_status_single_row_check" CHECK ("bcv_status"."id")
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"effective_date" date NOT NULL,
	"previous_rate" numeric(18, 8),
	"source" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_rate_check" CHECK ("exchange_rates"."rate" > 0),
	CONSTRAINT "exchange_rates_source_check" CHECK ("exchange_rates"."source" in ('bcv', 'manual')),
	CONSTRAINT "exchange_rates_author_check" CHECK ("exchange_rates"."source" = 'manual' or "exchange_rates"."changed_by" is null)
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" DROP CONSTRAINT "tenant_settings_exchange_rate_check";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attributes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "rate_source" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rates_tenant_created_idx" ON "exchange_rates" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_attributes_check" CHECK (jsonb_typeof("contacts"."attributes") = 'array' and jsonb_array_length("contacts"."attributes") <= 30);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_rate_source_check" CHECK ("tenant_settings"."rate_source" in ('bcv', 'custom'));
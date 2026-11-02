CREATE TABLE "delivery_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'zones' NOT NULL,
	"flat_price_cents" integer DEFAULT 0 NOT NULL,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_settings_mode_check" CHECK ("delivery_settings"."mode" in ('flat', 'zones')),
	CONSTRAINT "delivery_settings_flat_price_check" CHECK ("delivery_settings"."flat_price_cents" between 0 and 100000000),
	CONSTRAINT "delivery_settings_zones_check" CHECK (jsonb_typeof("delivery_settings"."zones") = 'array' and jsonb_array_length("delivery_settings"."zones") <= 100)
);
--> statement-breakpoint
ALTER TABLE "delivery_settings" ADD CONSTRAINT "delivery_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
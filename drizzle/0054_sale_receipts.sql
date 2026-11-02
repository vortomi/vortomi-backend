CREATE TABLE "receipt_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'vortomi' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"footer" text,
	"show_attended_by" boolean DEFAULT true NOT NULL,
	"show_payment_reference" boolean DEFAULT true NOT NULL,
	"logo_media_id" uuid,
	"next_number" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_settings_mode_check" CHECK ("receipt_settings"."mode" in ('vortomi', 'own', 'off')),
	CONSTRAINT "receipt_settings_prefix_check" CHECK ("receipt_settings"."prefix" ~ '^[A-Z0-9]{0,6}$'),
	CONSTRAINT "receipt_settings_text_check" CHECK (length("receipt_settings"."subtitle") <= 60 and length("receipt_settings"."phone") <= 30 and length(coalesce("receipt_settings"."footer", '')) <= 300),
	CONSTRAINT "receipt_settings_next_number_check" CHECK ("receipt_settings"."next_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sale_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"number" integer,
	"code" text,
	"media_id" uuid NOT NULL,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_receipts_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "sale_receipts_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "sale_receipts_number_check" CHECK (("sale_receipts"."number" is null) = ("sale_receipts"."code" is null) and coalesce("sale_receipts"."number", 1) >= 1)
);
--> statement-breakpoint
ALTER TABLE "media_files" ALTER COLUMN "wa_media_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_logo_fk" FOREIGN KEY ("tenant_id","logo_media_id") REFERENCES "public"."media_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_receipts" ADD CONSTRAINT "sale_receipts_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_receipts" ADD CONSTRAINT "sale_receipts_media_fk" FOREIGN KEY ("tenant_id","media_id") REFERENCES "public"."media_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_reference_check" CHECK (length(coalesce("orders"."payment_reference", '')) <= 40);
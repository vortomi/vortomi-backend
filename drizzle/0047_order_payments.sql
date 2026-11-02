CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_media_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_files_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "media_files_tenant_wa_media_key" UNIQUE("tenant_id","wa_media_id"),
	CONSTRAINT "media_files_size_check" CHECK ("media_files"."size_bytes" between 1 and 5242880)
);
--> statement-breakpoint
CREATE TABLE "order_receipts" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_receipts_pkey" PRIMARY KEY("tenant_id","order_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "order_receipts" ADD CONSTRAINT "order_receipts_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_receipts" ADD CONSTRAINT "order_receipts_media_fk" FOREIGN KEY ("tenant_id","media_id") REFERENCES "public"."media_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Orders placed before payments existed: waiting for payment, or confirmed if a person had taken them.
UPDATE "orders" SET "status" = CASE "status" WHEN 'new' THEN 'awaiting_payment' WHEN 'in_progress' THEN 'confirmed' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('awaiting_payment', 'payment_review', 'confirmed', 'done', 'cancelled'));
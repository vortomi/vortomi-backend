CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"reference_rule" text DEFAULT 'required' NOT NULL,
	"receipt_rule" text DEFAULT 'required' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_methods_type_check" CHECK ("payment_methods"."type" in ('pago_movil', 'transfer_national', 'zelle', 'paypal', 'binance', 'transfer_international', 'cash_usd', 'cash_ves', 'cash_eur', 'arrange')),
	CONSTRAINT "payment_methods_reference_rule_check" CHECK ("payment_methods"."reference_rule" in ('required', 'optional', 'none')),
	CONSTRAINT "payment_methods_receipt_rule_check" CHECK ("payment_methods"."receipt_rule" in ('required', 'optional', 'none')),
	CONSTRAINT "payment_methods_text_check" CHECK (length(btrim("payment_methods"."name")) between 2 and 120 and length("payment_methods"."instructions") <= 2000),
	CONSTRAINT "payment_methods_fields_check" CHECK (jsonb_typeof("payment_methods"."fields") = 'array' and jsonb_array_length("payment_methods"."fields") <= 12)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_method_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_methods_tenant_order_idx" ON "payment_methods" USING btree ("tenant_id","sort_order");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_method_fk" FOREIGN KEY ("tenant_id","payment_method_id") REFERENCES "public"."payment_methods"("tenant_id","id") ON DELETE no action ON UPDATE no action;
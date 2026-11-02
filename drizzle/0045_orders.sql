CREATE TABLE "order_lines" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_ref" text NOT NULL,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "order_lines_order_position_key" UNIQUE("tenant_id","order_id","position"),
	CONSTRAINT "order_lines_quantity_check" CHECK ("order_lines"."quantity" between 1 and 1000),
	CONSTRAINT "order_lines_price_check" CHECK ("order_lines"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source_key" text NOT NULL,
	"customer_name" text NOT NULL,
	"fulfillment" text NOT NULL,
	"zone" text,
	"address" text,
	"payment_method" text,
	"notes" text DEFAULT '' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"delivery_cents" integer,
	"bs_per_usd" numeric(18, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_tenant_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "orders_tenant_source_key" UNIQUE("tenant_id","source_key"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('new', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "orders_fulfillment_check" CHECK ("orders"."fulfillment" in ('pickup', 'delivery')),
	CONSTRAINT "orders_payment_method_check" CHECK ("orders"."payment_method" in ('cash_usd', 'cash_ves', 'pago_movil', 'card', 'transfer', 'zelle')),
	CONSTRAINT "orders_amounts_check" CHECK ("orders"."subtotal_cents" >= 0 and ("orders"."delivery_cents" is null or "orders"."delivery_cents" >= 0)),
	CONSTRAINT "orders_delivery_address_check" CHECK ("orders"."fulfillment" = 'pickup' or length(coalesce("orders"."address", '')) > 0),
	CONSTRAINT "orders_text_check" CHECK (length("orders"."customer_name") between 1 and 80 and length("orders"."notes") <= 500 and length(coalesce("orders"."address", '')) <= 300)
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_handoff_reason_check";--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_reason_check" CHECK ("conversations"."handoff_reason" in ('customer_asked', 'purchase', 'order_placed', 'agent_unsure', 'agent_error', 'limit_reached'));
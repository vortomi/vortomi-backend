CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"price_cents" integer NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."price_cents" >= 0),
	CONSTRAINT "product_variants_stock_check" CHECK ("product_variants"."reserved" >= 0 and "product_variants"."on_hand" >= "product_variants"."reserved"),
	CONSTRAINT "product_variants_threshold_check" CHECK ("product_variants"."low_stock_threshold" >= 0),
	CONSTRAINT "product_variants_sku_check" CHECK (length(trim("product_variants"."sku")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"stock_mode" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_stock_mode_check" CHECK ("products"."stock_mode" in ('availability', 'units')),
	CONSTRAINT "products_name_check" CHECK (length(trim("products"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_kind_check" CHECK ("stock_movements"."kind" in ('initial', 'purchase', 'sale', 'adjustment', 'loss', 'return')),
	CONSTRAINT "stock_movements_sign_check" CHECK (case
        when "stock_movements"."kind" in ('initial', 'purchase', 'return') then "stock_movements"."quantity" > 0
        when "stock_movements"."kind" in ('sale', 'loss') then "stock_movements"."quantity" < 0
        else "stock_movements"."quantity" <> 0 end),
	CONSTRAINT "stock_movements_reason_check" CHECK (length("stock_movements"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_key" ON "product_variants" USING btree ("tenant_id",lower("sku"));--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_created_idx" ON "stock_movements" USING btree ("tenant_id","variant_id","created_at");
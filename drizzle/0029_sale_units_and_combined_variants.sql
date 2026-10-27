DROP INDEX "product_variants_product_option_key";--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "on_hand" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "reserved" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "low_stock_threshold" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "variant_type_2_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "option_2_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "variant_type_3_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "option_3_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant_type_2_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant_type_3_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sale_unit" text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_quantity" numeric(14, 3) DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quantity_step" numeric(14, 3) DEFAULT 1 NOT NULL;--> statement-breakpoint
-- The unique keys go first: the variants' composite foreign keys point at them.
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_type_2_key" UNIQUE("tenant_id","id","variant_type_2_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_type_3_key" UNIQUE("tenant_id","id","variant_type_3_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_type_2_fk" FOREIGN KEY ("tenant_id","product_id","variant_type_2_id") REFERENCES "public"."products"("tenant_id","id","variant_type_2_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_type_3_fk" FOREIGN KEY ("tenant_id","product_id","variant_type_3_id") REFERENCES "public"."products"("tenant_id","id","variant_type_3_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_2_fk" FOREIGN KEY ("tenant_id","variant_type_2_id","option_2_id") REFERENCES "public"."variant_options"("tenant_id","type_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_3_fk" FOREIGN KEY ("tenant_id","variant_type_3_id","option_3_id") REFERENCES "public"."variant_options"("tenant_id","type_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_variant_type_2_fk" FOREIGN KEY ("tenant_id","variant_type_2_id") REFERENCES "public"."variant_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_variant_type_3_fk" FOREIGN KEY ("tenant_id","variant_type_3_id") REFERENCES "public"."variant_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_option_key" ON "product_variants" USING btree ("tenant_id","product_id","option_id",coalesce("option_2_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("option_3_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "product_variants"."option_id" is not null;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_2_check" CHECK (("product_variants"."option_2_id" is null) = ("product_variants"."variant_type_2_id" is null));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_3_check" CHECK (("product_variants"."option_3_id" is null) = ("product_variants"."variant_type_3_id" is null));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_variant_types_check" CHECK (("products"."variant_type_2_id" is null or ("products"."variant_type_id" is not null and "products"."variant_type_2_id" <> "products"."variant_type_id"))
        and ("products"."variant_type_3_id" is null or ("products"."variant_type_2_id" is not null and "products"."variant_type_3_id" not in ("products"."variant_type_id", "products"."variant_type_2_id"))));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sale_unit_check" CHECK ("products"."sale_unit" in ('unit', 'pair', 'dozen', 'box', 'pack', 'roll', 'kg', 'g', 'm', 'm2', 'l', 'hour', 'service', 'session'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_quantities_check" CHECK ("products"."min_quantity" > 0 and "products"."quantity_step" > 0
        and ("products"."sale_unit" in ('kg', 'm', 'm2', 'l', 'hour') or ("products"."quantity_step" = 1 and "products"."min_quantity" = trunc("products"."min_quantity"))));
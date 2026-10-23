CREATE TABLE "variant_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_options_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "variant_options_tenant_type_id_key" UNIQUE("tenant_id","type_id","id"),
	CONSTRAINT "variant_options_value_check" CHECK (length(trim("variant_options"."value")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "variant_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_types_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "variant_types_name_check" CHECK (length(trim("variant_types"."name")) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "variant_type_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "option_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant_type_id" uuid;--> statement-breakpoint
ALTER TABLE "variant_options" ADD CONSTRAINT "variant_options_type_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."variant_types"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_types" ADD CONSTRAINT "variant_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variant_options_type_value_key" ON "variant_options" USING btree ("tenant_id","type_id",lower("value"));--> statement-breakpoint
CREATE UNIQUE INDEX "variant_types_tenant_name_key" ON "variant_types" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_type_key" UNIQUE("tenant_id","id","variant_type_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_type_fk" FOREIGN KEY ("tenant_id","product_id","variant_type_id") REFERENCES "public"."products"("tenant_id","id","variant_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_fk" FOREIGN KEY ("tenant_id","variant_type_id","option_id") REFERENCES "public"."variant_options"("tenant_id","type_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_variant_type_fk" FOREIGN KEY ("tenant_id","variant_type_id") REFERENCES "public"."variant_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_option_key" ON "product_variants" USING btree ("tenant_id","product_id","option_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_option_check" CHECK (("product_variants"."option_id" is null) = ("product_variants"."variant_type_id" is null));
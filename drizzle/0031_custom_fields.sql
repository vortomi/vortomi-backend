CREATE TABLE "custom_field_categories" (
	"tenant_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "custom_field_categories_pkey" PRIMARY KEY("tenant_id","field_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_options_value_check" CHECK (length(trim("custom_field_options"."value")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_fields_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_fields_entity_check" CHECK ("custom_fields"."entity" in ('product', 'contact')),
	CONSTRAINT "custom_fields_kind_check" CHECK ("custom_fields"."kind" in ('text', 'number', 'choice', 'multi_choice', 'boolean', 'date')),
	CONSTRAINT "custom_fields_label_check" CHECK (length(trim("custom_fields"."label")) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_categories" ADD CONSTRAINT "custom_field_categories_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."custom_fields"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_categories" ADD CONSTRAINT "custom_field_categories_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_options" ADD CONSTRAINT "custom_field_options_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."custom_fields"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_options_value_key" ON "custom_field_options" USING btree ("tenant_id","field_id",lower("value"));--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_tenant_entity_label_key" ON "custom_fields" USING btree ("tenant_id","entity",lower("label"));--> statement-breakpoint
CREATE INDEX "contacts_custom_values_idx" ON "contacts" USING gin ("custom_values");--> statement-breakpoint
CREATE INDEX "products_custom_values_idx" ON "products" USING gin ("custom_values");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_custom_values_check" CHECK (jsonb_typeof("contacts"."custom_values") = 'object');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_custom_values_check" CHECK (jsonb_typeof("products"."custom_values") = 'object');
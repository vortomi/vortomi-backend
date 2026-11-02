CREATE TABLE "business_types" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"icon" text DEFAULT 'tag' NOT NULL,
	"position" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_types_code_check" CHECK ("business_types"."code" ~ '^[a-z0-9_]{2,40}$'),
	CONSTRAINT "business_types_label_check" CHECK (length(trim("business_types"."label")) between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "business_type" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "business_type_other" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sells" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sell_method" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "default_sale_unit" text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "default_stock_mode" text DEFAULT 'units' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "business_types_label_key" ON "business_types" USING btree (lower("label"));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_business_types_code_fk" FOREIGN KEY ("business_type") REFERENCES "public"."business_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sells_check" CHECK ("tenants"."sells" in ('products', 'services', 'both', 'none'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sell_method_check" CHECK ("tenants"."sell_method" in ('unit', 'weight', 'measure', 'time', 'mixed'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_other_check" CHECK (length("tenants"."business_type_other") <= 60);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_default_sale_unit_check" CHECK ("tenant_settings"."default_sale_unit" in ('unit', 'pair', 'dozen', 'box', 'pack', 'roll', 'kg', 'g', 'm', 'm2', 'l', 'hour', 'service', 'session'));--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_default_stock_mode_check" CHECK ("tenant_settings"."default_stock_mode" in ('availability', 'units'));--> statement-breakpoint
-- The closed list of business types (block C), in the order the welcome shows them.
INSERT INTO "business_types" ("code", "label", "icon", "position") VALUES
  ('auto_parts', 'Repuestos y autopartes', 'car', 1),
  ('hardware', 'Ferretería y construcción', 'hammer', 2),
  ('apparel', 'Ropa y calzado', 'shirt', 3),
  ('food', 'Alimentos', 'bread', 4),
  ('pharmacy', 'Farmacia', 'pill', 5),
  ('furniture', 'Muebles y hogar', 'sofa', 6),
  ('electronics', 'Electrónica y tecnología', 'laptop', 7),
  ('beauty', 'Belleza y cuidado personal', 'sparkles', 8),
  ('health', 'Salud', 'stethoscope', 9),
  ('technical_services', 'Servicios técnicos y talleres', 'wrench', 10),
  ('other', 'Otro', 'dots', 99);
--> statement-breakpoint
-- The rubro the console used to keep as text becomes a type; what does not fit stays as «Otro»
-- with its text, for our team to classify.
UPDATE "tenants" SET
  "business_type" = CASE "industry"
    WHEN 'Repuestos' THEN 'auto_parts'
    WHEN 'Repostería' THEN 'food'
    WHEN 'Comida y delivery' THEN 'food'
    WHEN 'Salud' THEN 'health'
    WHEN 'Farmacia' THEN 'pharmacy'
    WHEN 'Mecánica' THEN 'technical_services'
    WHEN 'Hogar' THEN 'furniture'
    WHEN 'Moda' THEN 'apparel'
    ELSE 'other' END,
  "business_type_other" = CASE
    WHEN "industry" IN ('Repuestos', 'Repostería', 'Comida y delivery', 'Salud', 'Farmacia', 'Mecánica', 'Hogar', 'Moda', 'Otro') THEN ''
    ELSE left("industry", 60) END
 WHERE "industry" <> '';

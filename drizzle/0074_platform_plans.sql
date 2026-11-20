CREATE TABLE "platform_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"discount_1" smallint DEFAULT 0 NOT NULL,
	"discount_3" smallint DEFAULT 0 NOT NULL,
	"discount_6" smallint DEFAULT 0 NOT NULL,
	"discount_12" smallint DEFAULT 0 NOT NULL,
	"benefits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_plans_name_check" CHECK (length(btrim("platform_plans"."name")) between 2 and 60),
	CONSTRAINT "platform_plans_description_check" CHECK (length("platform_plans"."description") <= 500),
	CONSTRAINT "platform_plans_price_check" CHECK ("platform_plans"."price_cents" between 1 and 10000000),
	CONSTRAINT "platform_plans_discounts_check" CHECK ("platform_plans"."discount_1" between 0 and 90 and "platform_plans"."discount_3" between 0 and 90 and "platform_plans"."discount_6" between 0 and 90 and "platform_plans"."discount_12" between 0 and 90),
	CONSTRAINT "platform_plans_benefits_check" CHECK (jsonb_typeof("platform_plans"."benefits") = 'array' and jsonb_array_length("platform_plans"."benefits") <= 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_plans_name_key" ON "platform_plans" USING btree (lower(btrim("name")));--> statement-breakpoint
-- Vortomi's own data, as platform_payment_methods (0073): RLS on with no policy and nothing granted,
-- so companies' tenant_scoped code and Supabase's public API never read the plans.
ALTER TABLE public.platform_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'tenant_scoped'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.platform_plans FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

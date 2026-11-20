CREATE TABLE "platform_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	CONSTRAINT "platform_payment_methods_type_check" CHECK ("platform_payment_methods"."type" in ('pago_movil', 'transfer_national', 'zelle', 'paypal', 'binance', 'transfer_international', 'cash_usd', 'cash_ves', 'cash_eur', 'arrange')),
	CONSTRAINT "platform_payment_methods_reference_rule_check" CHECK ("platform_payment_methods"."reference_rule" in ('required', 'optional', 'none')),
	CONSTRAINT "platform_payment_methods_receipt_rule_check" CHECK ("platform_payment_methods"."receipt_rule" in ('required', 'optional', 'none')),
	CONSTRAINT "platform_payment_methods_text_check" CHECK (length(btrim("platform_payment_methods"."name")) between 2 and 120 and length("platform_payment_methods"."instructions") <= 2000),
	CONSTRAINT "platform_payment_methods_fields_check" CHECK (jsonb_typeof("platform_payment_methods"."fields") = 'array' and jsonb_array_length("platform_payment_methods"."fields") <= 12)
);
--> statement-breakpoint
CREATE INDEX "platform_payment_methods_order_idx" ON "platform_payment_methods" USING btree ("sort_order");--> statement-breakpoint
-- Vortomi's own data, as channel_app_checks (0072): RLS on with no policy and nothing granted, so
-- companies' tenant_scoped code and Supabase's public API never read where Vortomi gets paid.
ALTER TABLE public.platform_payment_methods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'tenant_scoped'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.platform_payment_methods FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

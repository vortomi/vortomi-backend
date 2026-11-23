CREATE TABLE "platform_exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"effective_date" date NOT NULL,
	"previous_rate" numeric(18, 8),
	"source" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_exchange_rates_rate_check" CHECK ("platform_exchange_rates"."rate" > 0),
	CONSTRAINT "platform_exchange_rates_source_check" CHECK ("platform_exchange_rates"."source" in ('bcv', 'manual')),
	CONSTRAINT "platform_exchange_rates_author_check" CHECK (("platform_exchange_rates"."source" = 'manual') = ("platform_exchange_rates"."changed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"rate_source" text DEFAULT 'custom' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_single_row_check" CHECK ("platform_settings"."id"),
	CONSTRAINT "platform_settings_rate_source_check" CHECK ("platform_settings"."rate_source" in ('bcv', 'custom'))
);
--> statement-breakpoint
ALTER TABLE "platform_exchange_rates" ADD CONSTRAINT "platform_exchange_rates_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_exchange_rates_created_idx" ON "platform_exchange_rates" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
-- No rate of Vortomi is ever changed or deleted, as a company's (0028): the history only grows.
CREATE TRIGGER platform_exchange_rates_append_only
  BEFORE UPDATE OR DELETE ON public.platform_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint
-- Vortomi's own data, as its plans (0074): RLS on with no policy and nothing granted, so companies'
-- tenant_scoped code and Supabase's public API never read or write Vortomi's rate or settings.
ALTER TABLE public.platform_exchange_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'tenant_scoped'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.platform_exchange_rates, public.platform_settings FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

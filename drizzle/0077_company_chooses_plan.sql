CREATE TABLE "company_trials" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD COLUMN "origin" text DEFAULT 'console' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_trials" ADD CONSTRAINT "company_trials_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_origin_check" CHECK ("company_subscriptions"."origin" in ('company', 'console'));--> statement-breakpoint
-- A company reads its own trial (its panel counts the days, and the check that keeps a company
-- without a plan out once its trial is over); it never writes it.
ALTER TABLE public.company_trials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.company_trials FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.company_trials FROM %I', api_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    REVOKE ALL ON public.company_trials FROM tenant_scoped;
    GRANT SELECT ON public.company_trials TO tenant_scoped;
  END IF;
END $$;
--> statement-breakpoint
-- The companies already live get their 7 days from today (Caracas): decided 24/11/2026.
INSERT INTO public.company_trials (company_id, ends_on)
SELECT id, (now() AT TIME ZONE 'America/Caracas')::date + 6
FROM public.tenants
WHERE status IN ('active', 'suspended')
ON CONFLICT (company_id) DO NOTHING;

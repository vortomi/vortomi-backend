CREATE TABLE "channel_app_checks" (
	"channel_account_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"apps" jsonb,
	"checked_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_app_checks" ADD CONSTRAINT "channel_app_checks_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Platform data, as password_resets (0071): RLS on with no policy and nothing granted, so
-- companies' tenant_scoped code and Supabase's public API never see which apps read a number.
ALTER TABLE public.channel_app_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'tenant_scoped'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.channel_app_checks FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

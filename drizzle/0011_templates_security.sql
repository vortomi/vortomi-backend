-- Message templates under tenant isolation, and one company per WhatsApp Business Account.

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.message_templates TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Created by admins, updated by Meta's verdicts; deleting needs Meta too, so not here.
GRANT SELECT, INSERT, UPDATE ON public.message_templates TO tenant_scoped;
--> statement-breakpoint

-- Template webhooks are routed by WABA id (src/modules/tenancy/channel-directory.ts).
-- A WABA shared by two companies would make that routing ambiguous: refuse it here.
CREATE FUNCTION public.channel_accounts_one_company_per_waba() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.channel_accounts
    WHERE waba_id = NEW.waba_id AND tenant_id <> NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'WhatsApp Business Account % already belongs to another company', NEW.waba_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER channel_accounts_one_company_per_waba
  BEFORE INSERT OR UPDATE OF waba_id, tenant_id ON public.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION public.channel_accounts_one_company_per_waba();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.channel_accounts_one_company_per_waba() FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.message_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

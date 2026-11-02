-- How each company gets paid, under the same company isolation as its other settings. Methods are
-- hidden, never deleted: no DELETE grant.

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payment_methods TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.payment_methods TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.payment_methods FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

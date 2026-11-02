-- The sales agent's tables, under the same company isolation as the rest.

ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.agent_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agent_settings TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agent_usage TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.agent_settings TO tenant_scoped;
--> statement-breakpoint
-- Usage only grows: counted by an upsert, never deleted.
GRANT SELECT, INSERT, UPDATE ON public.agent_usage TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.agent_settings, public.agent_usage FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

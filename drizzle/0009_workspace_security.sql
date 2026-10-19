-- Tenant isolation for settings, quick replies and the pipeline (same model as 0001).

ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.tenant_settings TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.quick_replies TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.pipeline_stages TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Settings are saved, never deleted. Quick replies and stages are managed by admins
-- (enforced by the API); deleting a stage still in use fails on contacts_stage_fk.
GRANT SELECT, INSERT, UPDATE ON public.tenant_settings TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quick_replies, public.pipeline_stages TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.tenant_settings, public.quick_replies, public.pipeline_stages FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

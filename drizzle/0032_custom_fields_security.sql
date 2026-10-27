-- The company's own fields under tenant isolation. The routes let only admins define them;
-- their values live on products and contacts, already isolated (0001, 0013).

ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.custom_field_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.custom_field_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.custom_fields TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.custom_field_options TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.custom_field_categories TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_fields, public.custom_field_options, public.custom_field_categories TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.custom_fields, public.custom_field_options, public.custom_field_categories FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

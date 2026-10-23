-- Variant types and their values under tenant isolation. Company code may also point an
-- existing variant at an option, never at its counts (those stay trigger-only, 0013).

ALTER TABLE public.variant_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.variant_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.variant_types TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.variant_options TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.variant_types TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.variant_options TO tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (variant_type_id, option_id) ON public.product_variants TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.variant_types, public.variant_options FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

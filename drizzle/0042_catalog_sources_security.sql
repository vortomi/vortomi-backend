-- A company's own catalog system and its key: platform-only, like channel_credentials. RLS on,
-- the usual policy for uniformity, and NO grant to tenant_scoped: company code gets "permission
-- denied"; only the server role reads it, right before calling that system
-- (src/modules/catalog-source).
ALTER TABLE public.catalog_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_sources TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.catalog_sources FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

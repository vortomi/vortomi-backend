-- Tenant isolation for tags and notes (same model as 0001_security_rls.sql).

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.tags TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contact_tags TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.notes TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Admins manage the tag list; anyone tags contacts; a note, once written, stays as written.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.contact_tags TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.notes TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.tags, public.contact_tags, public.notes FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

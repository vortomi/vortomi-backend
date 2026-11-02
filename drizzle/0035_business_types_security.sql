-- Business types are the platform's own list: every company reads it (the welcome shows it),
-- only our console changes it, as the server role.
ALTER TABLE public.business_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY public_read ON public.business_types FOR SELECT TO tenant_scoped USING (true);
--> statement-breakpoint
GRANT SELECT ON public.business_types TO tenant_scoped;
--> statement-breakpoint

-- A company's admins answer the welcome: its business type and how it sells. The rest of the
-- company row (status, plan, fiscal data) stays with our console (0023).
GRANT UPDATE (business_type, business_type_other, sells, sell_method, setup_completed_at) ON public.tenants TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.business_types FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

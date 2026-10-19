-- Tenant isolation for people and memberships (same model as 0001_security_rls.sql).
--
--   * memberships and membership_channels belong to one company: tenant_isolation.
--   * users is platform-level (one person, several companies). Tenant-scoped code may
--     only read the people who belong to ITS company, never the whole directory.
--   * Who the caller is gets resolved by the platform (src/modules/access), which
--     reads users and memberships by the verified Supabase user id only.

-- 1. RLS on the new tables.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.membership_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 2. Policies.
CREATE POLICY tenant_isolation ON public.memberships TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.membership_channels TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The subquery runs under memberships' own policy, so it can only match the current company.
CREATE POLICY members_of_current_tenant ON public.users FOR SELECT TO tenant_scoped
  USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = users.id));
--> statement-breakpoint

-- 3. Least privilege. People are created by the platform (accepting an invitation),
--    never by tenant-scoped code; admins manage memberships of their own company.
GRANT SELECT ON public.users TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.memberships TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.membership_channels TO tenant_scoped;
--> statement-breakpoint

-- 4. Supabase's public API roles get nothing on these tables either.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.users, public.memberships, public.membership_channels FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

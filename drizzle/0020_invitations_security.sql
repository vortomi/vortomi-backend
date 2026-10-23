-- Invitations under tenant isolation. A company's admins create, renew and revoke its own;
-- accepting one is platform work (the person is not a member yet), done by the server's
-- own connection after checking the token and the signed-in email.

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.invitations TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.invitations TO tenant_scoped;
--> statement-breakpoint

-- Admins rename their own numbers ("Ventas", "Despachos"); nothing else of a number is theirs to change.
GRANT UPDATE (label) ON public.channel_accounts TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.invitations FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

-- Tenant isolation inside the database (design document 8.8: second layer, Row Level Security).
--
-- How it works:
--   * The server connects with its own login role (the tables' owner). Platform code
--     (webhook inbox, routing by phone_number_id) runs as that role.
--   * Every tenant-scoped unit of work runs inside a transaction that does
--       set_config('app.tenant_id', <uuid>, true)  and  SET LOCAL ROLE tenant_scoped
--     (src/modules/tenancy/tenant-scope.ts). tenant_scoped has no BYPASSRLS, so the
--     policies below apply: it only sees and writes rows of that one company, and
--     without a company set it sees nothing at all.
--   * Supabase also publishes the schema through its Data API (anon, authenticated):
--     RLS without policies for them plus revoked privileges closes that door.

-- 1. The role tenant-scoped work runs as.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    CREATE ROLE tenant_scoped NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
-- The login role must be a member to be able to SET ROLE to it.
GRANT tenant_scoped TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tenant_scoped;
--> statement-breakpoint

-- 2. RLS on every table, with no exception (test/db/security.test.ts checks it).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- 3. One policy per tenant table: the row's company must be the transaction's company,
--    to read it (USING) and to write it (WITH CHECK). An empty or missing setting is NULL,
--    and NULL never matches: no company set means no rows.
CREATE POLICY tenant_isolation ON public.tenants TO tenant_scoped
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channel_accounts TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contacts TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.conversations TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.messages TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.message_status_events TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- 4. Least privilege. Companies and numbers are created by the platform, never by
--    tenant-scoped code; status events can only be added; webhook_events is not granted.
GRANT SELECT ON public.tenants, public.channel_accounts TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.contacts, public.conversations TO tenant_scoped;
--> statement-breakpoint
-- A stored message is never rewritten.
GRANT SELECT, INSERT ON public.messages TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.message_status_events TO tenant_scoped;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.messages_id_seq, public.message_status_events_id_seq TO tenant_scoped;
--> statement-breakpoint

-- 5. Status events are append-only for everyone, owner included (design document 8.3).
CREATE FUNCTION public.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER message_status_events_append_only
  BEFORE UPDATE OR DELETE ON public.message_status_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_change() FROM PUBLIC;
--> statement-breakpoint

-- 6. Current delivery status, derived from the events: the furthest one wins, whatever
--    order Meta delivered them in. security_invoker makes the view obey the caller's RLS;
--    without it a view runs as its owner and would leak every company's rows.
CREATE VIEW public.message_delivery_status WITH (security_invoker = true) AS
SELECT DISTINCT ON (tenant_id, wa_message_id)
  tenant_id,
  wa_message_id,
  status,
  occurred_at
FROM public.message_status_events
ORDER BY tenant_id, wa_message_id,
  CASE status WHEN 'failed' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END DESC;
--> statement-breakpoint
GRANT SELECT ON public.message_delivery_status TO tenant_scoped;
--> statement-breakpoint

-- 7. Supabase's public API roles get nothing. They only exist on Supabase.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

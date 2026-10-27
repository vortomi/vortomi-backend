-- Exchange rates: each company reads only its own; an admin adds typed rates as themself (the
-- API checks the role; the database checks the author). The BCV's rates are written by the
-- platform's reader (src/modules/exchange-rates/bcv-rate.service.ts), outside company scope.
-- No rate is ever changed or deleted: the history only grows.

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.exchange_rates FOR SELECT TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY typed_by_caller ON public.exchange_rates FOR INSERT TO tenant_scoped
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND source = 'manual'
    AND changed_by = nullif(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint
GRANT SELECT, INSERT ON public.exchange_rates TO tenant_scoped;
--> statement-breakpoint
CREATE TRIGGER exchange_rates_append_only
  BEFORE UPDATE OR DELETE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint

-- The BCV's last read is the same public figure for every company: readable, never writable.
ALTER TABLE public.bcv_status ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY public_read ON public.bcv_status FOR SELECT TO tenant_scoped USING (true);
--> statement-breakpoint
GRANT SELECT ON public.bcv_status TO tenant_scoped;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.exchange_rates, public.bcv_status FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

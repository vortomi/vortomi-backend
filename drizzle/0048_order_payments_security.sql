-- Files customers sent and the receipts of each order, under the same company isolation. A file
-- and a receipt are written once and never changed.

ALTER TABLE public.media_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.order_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.media_files TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_receipts TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON public.media_files, public.order_receipts TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.media_files, public.order_receipts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- A new receipt is a change of its order's conversation (real-time inbox, 0046).
CREATE OR REPLACE FUNCTION public.notify_order_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conversation uuid;
BEGIN
  SELECT o.conversation_id INTO conversation FROM public.orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
  PERFORM pg_notify('vortomi_inbox', json_build_object('t', NEW.tenant_id, 'c', conversation)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notify_order_receipt() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER order_receipts_notify_inbox AFTER INSERT ON public.order_receipts
  FOR EACH ROW EXECUTE FUNCTION public.notify_order_receipt();

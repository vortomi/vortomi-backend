-- Sale receipts (0054) under the same company isolation as orders. A company's receipt settings are
-- read and written by its own code (admins only, enforced by the routes); an issued receipt is
-- written once and never changed. Whoever checks a payment writes down its reference on the order.

ALTER TABLE public.receipt_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sale_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.receipt_settings TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sale_receipts TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.receipt_settings TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sale_receipts TO tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (payment_reference) ON public.orders TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.receipt_settings, public.sale_receipts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- A receipt sent with an order is a change of its conversation (real-time inbox, 0046 and 0048).
CREATE OR REPLACE FUNCTION public.notify_sale_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conversation uuid;
BEGIN
  SELECT o.conversation_id INTO conversation FROM public.orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
  PERFORM pg_notify('vortomi_inbox', json_build_object('t', NEW.tenant_id, 'c', conversation)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notify_sale_receipt() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sale_receipts_notify_inbox AFTER INSERT ON public.sale_receipts
  FOR EACH ROW EXECUTE FUNCTION public.notify_sale_receipt();

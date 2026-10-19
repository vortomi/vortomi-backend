-- Inventory under tenant isolation; stock only moves through immutable movements.

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.products TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.product_variants TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.stock_movements TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Company code edits products and the descriptive columns of variants, never the
-- counts: on_hand and reserved are not in its UPDATE grant.
GRANT SELECT, INSERT, UPDATE ON public.products TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.product_variants TO tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (name, sku, price_cents, available, low_stock_threshold) ON public.product_variants TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.stock_movements TO tenant_scoped;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.stock_movements_id_seq TO tenant_scoped;
--> statement-breakpoint

-- Movements are history: never updated or deleted, by anyone (reject_change from 0001).
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint

-- Each movement moves the count in the same statement. The UPDATE locks the variant
-- row, so two sales of the last unit are serialized: the second one breaks
-- product_variants_stock_check and fails as a whole (documentations/05).
-- SECURITY DEFINER because company code cannot write on_hand itself; it only ever
-- applies the movement being inserted, to its own company's variant.
CREATE FUNCTION public.apply_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.product_variants
     SET on_hand = on_hand + NEW.quantity
   WHERE tenant_id = NEW.tenant_id AND id = NEW.variant_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.apply_stock_movement() FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.products, public.product_variants, public.stock_movements FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

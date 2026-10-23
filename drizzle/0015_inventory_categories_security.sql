-- Product categories under tenant isolation, and the free-text categories already
-- typed on products turned into rows of the new list (the text column goes in 0016).

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.product_categories TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO tenant_scoped;
--> statement-breakpoint

-- One category per company and name, ignoring case and spaces ("Frenos", " frenos ").
-- When spellings differ, the capitalised one wins: byte order puts upper case first.
INSERT INTO public.product_categories (tenant_id, name)
SELECT DISTINCT ON (tenant_id, lower(trim(category))) tenant_id, left(trim(category), 60)
  FROM public.products
 WHERE trim(category) <> ''
 ORDER BY tenant_id, lower(trim(category)), trim(category) COLLATE "C";
--> statement-breakpoint

UPDATE public.products p
   SET category_id = c.id
  FROM public.product_categories c
 WHERE c.tenant_id = p.tenant_id
   AND lower(c.name) = lower(left(trim(p.category), 60));
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.product_categories FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

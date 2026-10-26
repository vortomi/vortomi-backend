-- The pipeline's history: only a trigger writes it, nobody edits or deletes it, and each
-- company reads only its own. Who moved the contact is app.user_id, which withMember()
-- sets for the request (src/modules/access/member-scope.ts); NULL when no person did it.

ALTER TABLE public.contact_stage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contact_stage_events TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON public.contact_stage_events TO tenant_scoped;
--> statement-breakpoint

CREATE TRIGGER contact_stage_events_append_only
  BEFORE UPDATE OR DELETE ON public.contact_stage_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint

-- SECURITY DEFINER: company code cannot insert history rows itself (SELECT only above); the
-- trigger writes exactly the move that just happened, to that contact's own company.
CREATE FUNCTION public.record_stage_move() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.contact_stage_events (tenant_id, contact_id, stage_id, quote_cents, changed_by)
  VALUES (NEW.tenant_id, NEW.id, NEW.stage_id, NEW.quote_cents, nullif(current_setting('app.user_id', true), '')::uuid);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_stage_move() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER contacts_record_stage_move
  AFTER UPDATE OF stage_id ON public.contacts
  FOR EACH ROW WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id)
  EXECUTE FUNCTION public.record_stage_move();
--> statement-breakpoint
-- A contact typed by hand straight into a stage is a move too.
CREATE TRIGGER contacts_record_stage_start
  AFTER INSERT ON public.contacts
  FOR EACH ROW WHEN (NEW.stage_id IS NOT NULL)
  EXECUTE FUNCTION public.record_stage_move();
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.contact_stage_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

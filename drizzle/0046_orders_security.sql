-- Orders and their lines, under the same company isolation as conversations. Lines are a snapshot:
-- written once with their order, never edited (no UPDATE grant); an order only changes its status.

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.orders TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_lines TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON public.orders TO tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON public.orders TO tenant_scoped;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.order_lines TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.orders, public.order_lines FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Real-time inbox (0022/0037): a new order or a status change is a change of its conversation.
CREATE OR REPLACE FUNCTION public.notify_inbox_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data record;
  conversation uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := OLD;
  ELSE
    row_data := NEW;
  END IF;
  IF TG_TABLE_NAME = 'conversations' THEN
    conversation := row_data.id;
  ELSIF TG_TABLE_NAME IN ('messages', 'notes', 'conversation_assignees', 'orders') THEN
    conversation := row_data.conversation_id;
  ELSIF TG_TABLE_NAME = 'message_status_events' THEN
    -- A status may arrive before its message is known: then only the company is told.
    SELECT m.conversation_id INTO conversation FROM public.messages m
     WHERE m.tenant_id = row_data.tenant_id AND m.wa_message_id = row_data.wa_message_id;
  ELSIF TG_TABLE_NAME = 'contacts' THEN
    SELECT c.id INTO conversation FROM public.conversations c
     WHERE c.tenant_id = row_data.tenant_id AND c.contact_id = row_data.id;
  ELSIF TG_TABLE_NAME = 'contact_tags' THEN
    SELECT c.id INTO conversation FROM public.conversations c
     WHERE c.tenant_id = row_data.tenant_id AND c.contact_id = row_data.contact_id;
  END IF;
  PERFORM pg_notify('vortomi_inbox', json_build_object('t', row_data.tenant_id, 'c', conversation)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.notify_inbox_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER orders_notify_inbox AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();

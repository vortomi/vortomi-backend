-- Who attends a conversation becomes a list (conversation_assignees). The one person each
-- conversation had until now is its first entry; conversations.assigned_user_id is dropped next.

INSERT INTO public.conversation_assignees (tenant_id, conversation_id, user_id)
SELECT tenant_id, id, assigned_user_id FROM public.conversations WHERE assigned_user_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE public.conversation_assignees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.conversation_assignees TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.conversation_assignees TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.conversation_assignees FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Real-time inbox (0022): a change of who attends is a change of that conversation.
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
  ELSIF TG_TABLE_NAME IN ('messages', 'notes', 'conversation_assignees') THEN
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
CREATE TRIGGER conversation_assignees_notify_inbox AFTER INSERT OR DELETE ON public.conversation_assignees
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();

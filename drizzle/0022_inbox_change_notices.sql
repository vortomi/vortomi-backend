-- Real-time inbox: the database itself announces every change the inbox shows, whatever
-- code path made it (webhook, panel, scripts). Postgres delivers a NOTIFY only when its
-- transaction commits, so nobody hears about a change that was rolled back.
--
-- The notice carries ids only, never content: {"t": tenant_id, "c": conversation_id | null}.
-- The server forwards it to the open panels of THAT company, which then read the data
-- again through the API, under the usual visibility rules (src/modules/realtime).

CREATE FUNCTION public.notify_inbox_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF TG_TABLE_NAME IN ('messages', 'notes') THEN
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

CREATE TRIGGER conversations_notify_inbox AFTER INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint
CREATE TRIGGER messages_notify_inbox AFTER INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint
CREATE TRIGGER notes_notify_inbox AFTER INSERT ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint
CREATE TRIGGER message_status_events_notify_inbox AFTER INSERT ON public.message_status_events
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint
CREATE TRIGGER contacts_notify_inbox AFTER UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint
CREATE TRIGGER contact_tags_notify_inbox AFTER INSERT OR DELETE ON public.contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();

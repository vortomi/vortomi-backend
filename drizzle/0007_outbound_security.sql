-- Outbound sending: credentials stay platform-only, and a stored message can only
-- receive its send result, once.

-- 1. Channel credentials: RLS on, the usual policy for uniformity, and NO grant at all.
--    Company code gets "permission denied"; only the server role reads them, right
--    before calling Meta (src/modules/channels/channel-credentials.ts).
ALTER TABLE public.channel_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channel_credentials TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- 2. A sent message gets its Meta id or its error afterwards, and nothing else changes.
--    Column-level grant for company code; the trigger holds for every role.
GRANT UPDATE (wa_message_id, send_error) ON public.messages TO tenant_scoped;
--> statement-breakpoint
CREATE FUNCTION public.messages_send_result_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.wa_message_id IS NOT NULL OR OLD.send_error IS NOT NULL THEN
    RAISE EXCEPTION 'message % already has its send result', OLD.id;
  END IF;
  IF to_jsonb(NEW) - 'wa_message_id' - 'send_error' IS DISTINCT FROM to_jsonb(OLD) - 'wa_message_id' - 'send_error' THEN
    RAISE EXCEPTION 'a stored message is never rewritten';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_send_result_only
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_send_result_only();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.messages_send_result_only() FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.channel_credentials FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

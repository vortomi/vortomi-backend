-- History media (coexistence): Meta sends the owner's past photos, audios and documents first as a
-- content-less "media_placeholder" (stored as type 'unsupported') and then each file apart, for the
-- last 14 days. A stored message is still never rewritten; the one new exception is filling such a
-- placeholder, once: only its type (a media type), its caption and its file id, nothing else.

-- 1. Company code may write those three columns; the trigger below decides when.
GRANT UPDATE (type, body, wa_media_id) ON public.messages TO tenant_scoped;
--> statement-breakpoint

-- 2. Same trigger (name kept: it already guards every UPDATE of messages), one more allowed change.
CREATE OR REPLACE FUNCTION public.messages_send_result_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A placeholder of the history becomes the file it was. Once: after it, it is no placeholder.
  IF OLD.type = 'unsupported' AND OLD.body IS NULL AND OLD.wa_media_id IS NULL
     AND NEW.type IN ('image', 'audio', 'video', 'document', 'sticker') AND NEW.wa_media_id IS NOT NULL
     AND to_jsonb(NEW) - 'type' - 'body' - 'wa_media_id' IS NOT DISTINCT FROM to_jsonb(OLD) - 'type' - 'body' - 'wa_media_id' THEN
    RETURN NEW;
  END IF;
  -- A sent message gets its Meta id or its error afterwards, once, and nothing else changes.
  IF OLD.wa_message_id IS NOT NULL OR OLD.send_error IS NOT NULL THEN
    RAISE EXCEPTION 'message % already has its send result', OLD.id;
  END IF;
  IF to_jsonb(NEW) - 'wa_message_id' - 'send_error' IS DISTINCT FROM to_jsonb(OLD) - 'wa_message_id' - 'send_error' THEN
    RAISE EXCEPTION 'a stored message is never rewritten';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.messages_send_result_only() FROM PUBLIC;

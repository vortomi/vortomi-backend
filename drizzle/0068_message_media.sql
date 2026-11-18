-- Option B (mockup web-24): our copy of the files messages carry. The message stays untouched;
-- this row says whether its file was copied and where (Cloudinary or Supabase Storage).

CREATE TABLE "message_media" (
	"tenant_id" uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage" text,
	"object_key" text,
	"mime_type" text,
	"size_bytes" integer,
	"file_name" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_media_pkey" PRIMARY KEY("tenant_id","message_id"),
	CONSTRAINT "message_media_kind_check" CHECK ("message_media"."kind" in ('image', 'audio', 'sticker', 'document')),
	CONSTRAINT "message_media_status_check" CHECK ("message_media"."status" in ('pending', 'stored', 'too_large', 'unavailable')),
	CONSTRAINT "message_media_storage_check" CHECK ("message_media"."storage" is null or "message_media"."storage" in ('cloudinary', 'supabase')),
	CONSTRAINT "message_media_stored_check" CHECK ("message_media"."status" <> 'stored' or ("message_media"."storage" is not null and "message_media"."object_key" is not null)),
	CONSTRAINT "message_media_size_check" CHECK ("message_media"."size_bytes" is null or "message_media"."size_bytes" >= 0),
	CONSTRAINT "message_media_file_name_check" CHECK ("message_media"."file_name" is null or length("message_media"."file_name") between 1 and 240)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_media_pending_idx" ON "message_media" USING btree ("next_attempt_at") WHERE "message_media"."status" = 'pending';--> statement-breakpoint

-- Company isolation, as every tenant table (0001): RLS with the usual policy.
ALTER TABLE public.message_media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.message_media TO tenant_scoped
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Company code records that a message brought a file and keeps its copy's progress; it never
-- moves a row to another message or company, nor deletes it.
GRANT SELECT, INSERT ON public.message_media TO tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (status, storage, object_key, mime_type, size_bytes, attempts, next_attempt_at, last_error, updated_at) ON public.message_media TO tenant_scoped;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.message_media FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Real-time inbox (0022/0046): a file copied (or given up) is a change of its conversation, so the
-- open chat swaps «Cargando foto…» for the photo.
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
  ELSIF TG_TABLE_NAME = 'message_media' THEN
    SELECT m.conversation_id INTO conversation FROM public.messages m
     WHERE m.tenant_id = row_data.tenant_id AND m.id = row_data.message_id;
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
-- Only updates: the row is born with its message, whose insert already announced it.
CREATE TRIGGER message_media_notify_inbox AFTER UPDATE ON public.message_media
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_change();
--> statement-breakpoint

-- Files of the last 7 days that arrived before this existed: Meta still has them, so they are copied too.
INSERT INTO public.message_media (tenant_id, message_id, kind)
SELECT m.tenant_id, m.id, m.type
  FROM public.messages m
 WHERE m.wa_media_id IS NOT NULL
   AND m.type IN ('image', 'audio', 'sticker', 'document')
   AND (m.direction = 'in' OR m.author = 'owner_app')
   AND m.created_at > now() - interval '7 days'
ON CONFLICT DO NOTHING;

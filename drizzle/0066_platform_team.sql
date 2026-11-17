CREATE TABLE "platform_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "platform_invitations_email_check" CHECK ("platform_invitations"."email" = lower("platform_invitations"."email") and "platform_invitations"."email" like '%_@_%'),
	CONSTRAINT "platform_invitations_name_check" CHECK (length(trim("platform_invitations"."name")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "platform_team_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform_team_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"subject_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_team_events_action_check" CHECK ("platform_team_events"."action" in ('admin.invited', 'admin.invitation_renewed', 'admin.invitation_revoked', 'admin.joined', 'admin.code_reset', 'admin.removed'))
);
--> statement-breakpoint
ALTER TABLE "platform_invitations" ADD CONSTRAINT "platform_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invitations" ADD CONSTRAINT "platform_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_team_events" ADD CONSTRAINT "platform_team_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invitations_open_email_key" ON "platform_invitations" USING btree ("email") WHERE "platform_invitations"."accepted_at" is null and "platform_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "platform_team_events_created_idx" ON "platform_team_events" USING btree ("created_at");--> statement-breakpoint

-- Platform data: only the server role (our console) reads or writes it. RLS on with no policy, and
-- nothing granted: companies' tenant_scoped code cannot see who our admins are.
ALTER TABLE public.platform_invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.platform_team_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The team's history is only ever added to, by everyone (reject_change: 0001).
CREATE TRIGGER platform_team_events_append_only
  BEFORE UPDATE OR DELETE ON public.platform_team_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.platform_invitations, public.platform_team_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

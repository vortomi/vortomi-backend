CREATE TABLE "platform_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"company_id" uuid,
	"company_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_activity_action_check" CHECK ("platform_activity"."action" in ('tenant.created', 'tenant.updated', 'tenant.draft_discarded', 'tenant.activated', 'tenant.suspended', 'tenant.cancelled', 'channel.connected', 'channel.replaced', 'channel.refreshed', 'tenant.admin_invited', 'tenant.owner_invited', 'tenant.invitation_renewed', 'tenant.invitation_revoked', 'business_type.created', 'business_type.reclassified')),
	CONSTRAINT "platform_activity_company_name_check" CHECK ("platform_activity"."company_name" is null or length("platform_activity"."company_name") <= 200)
);
--> statement-breakpoint
ALTER TABLE "platform_team_events" DROP CONSTRAINT "platform_team_events_action_check";--> statement-breakpoint
ALTER TABLE "platform_activity" ADD CONSTRAINT "platform_activity_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_activity_created_idx" ON "platform_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_activity_actor_idx" ON "platform_activity" USING btree ("actor_user_id","created_at");--> statement-breakpoint
ALTER TABLE "platform_team_events" ADD CONSTRAINT "platform_team_events_action_check" CHECK ("platform_team_events"."action" in ('admin.invited', 'admin.invitation_renewed', 'admin.invitation_revoked', 'admin.joined', 'admin.code_reset', 'admin.removed', 'admin.session_ended', 'admin.sessions_ended'));
--> statement-breakpoint

-- Platform data, as platform_team_events (0066): RLS on with no policy and nothing granted, so
-- companies' tenant_scoped code and Supabase's public API never see what our staff does.
ALTER TABLE public.platform_activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only ever added to, by everyone (reject_change: 0001).
CREATE TRIGGER platform_activity_append_only
  BEFORE UPDATE OR DELETE ON public.platform_activity
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.platform_activity FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

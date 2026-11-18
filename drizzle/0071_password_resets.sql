CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"company_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "platform_activity" DROP CONSTRAINT "platform_activity_action_check";--> statement-breakpoint
ALTER TABLE "platform_team_events" DROP CONSTRAINT "platform_team_events_action_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_resets_company_idx" ON "password_resets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner_key" ON "memberships" USING btree ("tenant_id") WHERE "memberships"."is_owner";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_owner_check" CHECK (not "memberships"."is_owner" or ("memberships"."role" = 'admin' and "memberships"."status" = 'active'));--> statement-breakpoint
ALTER TABLE "platform_activity" ADD CONSTRAINT "platform_activity_action_check" CHECK ("platform_activity"."action" in ('tenant.created', 'tenant.updated', 'tenant.draft_discarded', 'tenant.activated', 'tenant.suspended', 'tenant.cancelled', 'channel.connected', 'channel.replaced', 'channel.refreshed', 'tenant.admin_invited', 'tenant.owner_invited', 'tenant.invitation_renewed', 'tenant.invitation_revoked', 'business_type.created', 'business_type.reclassified', 'tenant.password_reset', 'tenant.owner_changed'));--> statement-breakpoint
ALTER TABLE "platform_team_events" ADD CONSTRAINT "platform_team_events_action_check" CHECK ("platform_team_events"."action" in ('admin.invited', 'admin.invitation_renewed', 'admin.invitation_revoked', 'admin.joined', 'admin.code_reset', 'admin.removed', 'admin.session_ended', 'admin.sessions_ended', 'admin.password_reset'));--> statement-breakpoint

-- Each company's owner (mockup web-30): its first active admin, by when they joined.
UPDATE public.memberships m SET is_owner = true
FROM (
  SELECT DISTINCT ON (tenant_id) tenant_id, user_id
  FROM public.memberships
  WHERE role = 'admin' AND status = 'active'
  ORDER BY tenant_id, created_at, user_id
) first_admin
WHERE m.tenant_id = first_admin.tenant_id AND m.user_id = first_admin.user_id;
--> statement-breakpoint
-- Only the server sets the owner, and only the server adds people (invitation accept): a company's
-- code changes role, status and who sees others' conversations, nothing else.
REVOKE INSERT, UPDATE ON public.memberships FROM tenant_scoped;
--> statement-breakpoint
GRANT UPDATE (role, status, can_see_others) ON public.memberships TO tenant_scoped;
--> statement-breakpoint
-- Platform data, as platform_invitations (0066): RLS on with no policy and nothing granted, so
-- companies' tenant_scoped code and Supabase's public API never see a password link.
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.password_resets FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

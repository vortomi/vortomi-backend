CREATE TABLE "company_exemptions" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"ends_on" date,
	"forgiven_cents" integer DEFAULT 0 NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_exemptions_reason_check" CHECK ("company_exemptions"."reason" in ('demo', 'internal', 'founder', 'agreement', 'other')),
	CONSTRAINT "company_exemptions_note_check" CHECK ("company_exemptions"."note" is null or char_length("company_exemptions"."note") <= 300),
	CONSTRAINT "company_exemptions_other_note_check" CHECK ("company_exemptions"."reason" <> 'other' or "company_exemptions"."note" is not null),
	CONSTRAINT "company_exemptions_forgiven_check" CHECK ("company_exemptions"."forgiven_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "platform_activity" DROP CONSTRAINT "platform_activity_action_check";--> statement-breakpoint
ALTER TABLE "company_exemptions" ADD CONSTRAINT "company_exemptions_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_exemptions" ADD CONSTRAINT "company_exemptions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_activity" ADD CONSTRAINT "platform_activity_action_check" CHECK ("platform_activity"."action" in ('tenant.created', 'tenant.updated', 'tenant.draft_discarded', 'tenant.activated', 'tenant.suspended', 'tenant.cancelled', 'channel.connected', 'channel.replaced', 'channel.refreshed', 'tenant.admin_invited', 'tenant.owner_invited', 'tenant.invitation_renewed', 'tenant.invitation_revoked', 'business_type.created', 'business_type.reclassified', 'tenant.password_reset', 'tenant.owner_changed', 'subscription.plan_assigned', 'subscription.payment_approved', 'subscription.payment_rejected', 'subscription.exempted', 'subscription.exemption_changed', 'subscription.exemption_removed'));--> statement-breakpoint
-- A company reads only whether it is exempt and until when; the reason and the note are Vortomi's.
-- Only the console writes exemptions, as the platform.
ALTER TABLE public.company_exemptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.company_exemptions FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.company_exemptions FROM %I', api_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    REVOKE ALL ON public.company_exemptions FROM tenant_scoped;
    GRANT SELECT (company_id, ends_on) ON public.company_exemptions TO tenant_scoped;
  END IF;
END $$;

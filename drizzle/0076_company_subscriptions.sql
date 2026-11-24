CREATE TABLE "company_subscriptions" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	"billing_day" smallint,
	"next_due_on" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_subscriptions_billing_day_check" CHECK ("company_subscriptions"."billing_day" is null or "company_subscriptions"."billing_day" between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE "subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"base_price_cents" integer NOT NULL,
	"discounts" jsonb NOT NULL,
	"months" smallint DEFAULT 1 NOT NULL,
	"discount_percent" smallint DEFAULT 0 NOT NULL,
	"amount_cents" integer NOT NULL,
	"due_on" date NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_charges_months_check" CHECK ("subscription_charges"."months" between 1 and 36),
	CONSTRAINT "subscription_charges_discount_check" CHECK ("subscription_charges"."discount_percent" between 0 and 90),
	CONSTRAINT "subscription_charges_amounts_check" CHECK ("subscription_charges"."base_price_cents" > 0 and "subscription_charges"."amount_cents" > 0 and "subscription_charges"."paid_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "platform_activity" DROP CONSTRAINT "platform_activity_action_check";--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_plan_id_platform_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."platform_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_plan_id_platform_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."platform_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_charges_company_due_idx" ON "subscription_charges" USING btree ("company_id","due_on");--> statement-breakpoint
ALTER TABLE "platform_activity" ADD CONSTRAINT "platform_activity_action_check" CHECK ("platform_activity"."action" in ('tenant.created', 'tenant.updated', 'tenant.draft_discarded', 'tenant.activated', 'tenant.suspended', 'tenant.cancelled', 'channel.connected', 'channel.replaced', 'channel.refreshed', 'tenant.admin_invited', 'tenant.owner_invited', 'tenant.invitation_renewed', 'tenant.invitation_revoked', 'business_type.created', 'business_type.reclassified', 'tenant.password_reset', 'tenant.owner_changed', 'subscription.plan_assigned'));--> statement-breakpoint
-- A company reads only its own subscription and charges (the panel's Suscripción, and the check
-- that keeps an unpaid company out of every screen but that one); it never writes them: the
-- console assigns plans and the payments update charges, as the platform, outside company scope.
ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.subscription_charges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.company_subscriptions FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscription_charges FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.company_subscriptions, public.subscription_charges FROM %I', api_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    REVOKE ALL ON public.company_subscriptions, public.subscription_charges FROM tenant_scoped;
    GRANT SELECT ON public.company_subscriptions, public.subscription_charges TO tenant_scoped;
  END IF;
END $$;

CREATE TABLE "subscription_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"payment_id" uuid,
	"charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_movements_kind_check" CHECK ("wallet_movements"."kind" in ('excess', 'applied')),
	CONSTRAINT "wallet_movements_sign_check" CHECK (("wallet_movements"."kind" = 'excess' and "wallet_movements"."amount_cents" > 0) or ("wallet_movements"."kind" = 'applied' and "wallet_movements"."amount_cents" < 0))
);
--> statement-breakpoint
ALTER TABLE "platform_activity" DROP CONSTRAINT "platform_activity_action_check";--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN "received_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN "received_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "subscription_receipts" ADD CONSTRAINT "subscription_receipts_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_receipts" ADD CONSTRAINT "subscription_receipts_payment_id_subscription_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."subscription_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_payment_id_subscription_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."subscription_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_movements" ADD CONSTRAINT "wallet_movements_charge_id_subscription_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."subscription_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_receipts_payment_unique" ON "subscription_receipts" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_receipts_number_unique" ON "subscription_receipts" USING btree ("number");--> statement-breakpoint
CREATE INDEX "wallet_movements_company_idx" ON "wallet_movements" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "platform_activity" ADD CONSTRAINT "platform_activity_action_check" CHECK ("platform_activity"."action" in ('tenant.created', 'tenant.updated', 'tenant.draft_discarded', 'tenant.activated', 'tenant.suspended', 'tenant.cancelled', 'channel.connected', 'channel.replaced', 'channel.refreshed', 'tenant.admin_invited', 'tenant.owner_invited', 'tenant.invitation_renewed', 'tenant.invitation_revoked', 'business_type.created', 'business_type.reclassified', 'tenant.password_reset', 'tenant.owner_changed', 'subscription.plan_assigned', 'subscription.payment_approved', 'subscription.payment_rejected'));--> statement-breakpoint
-- A company reads its own balance movements and receipts; it never writes them: the console's
-- review and the daily charges write them, as the platform.
ALTER TABLE public.wallet_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.subscription_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.wallet_movements FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscription_receipts FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.wallet_movements, public.subscription_receipts FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.subscription_receipts_number_seq FROM %I', api_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    REVOKE ALL ON public.wallet_movements, public.subscription_receipts FROM tenant_scoped;
    GRANT SELECT ON public.wallet_movements, public.subscription_receipts TO tenant_scoped;
  END IF;
END $$;

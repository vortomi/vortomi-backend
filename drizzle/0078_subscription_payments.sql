CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid,
	"months" smallint NOT NULL,
	"method_id" uuid,
	"method_name" text NOT NULL,
	"method_type" text NOT NULL,
	"currency" text NOT NULL,
	"payer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"bs_per_usd" numeric(18, 8),
	"amount_usd_cents" integer NOT NULL,
	"proof_key" text,
	"proof_mime_type" text,
	"proof_size_bytes" integer,
	"status" text DEFAULT 'in_review' NOT NULL,
	"rejection_reason" text,
	"rejection_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_status_check" CHECK ("subscription_payments"."status" in ('in_review', 'approved', 'rejected')),
	CONSTRAINT "subscription_payments_currency_check" CHECK ("subscription_payments"."currency" in ('USD', 'VES')),
	CONSTRAINT "subscription_payments_amount_check" CHECK ("subscription_payments"."amount" > 0 and "subscription_payments"."amount_usd_cents" > 0),
	CONSTRAINT "subscription_payments_months_check" CHECK ("subscription_payments"."months" between 1 and 36)
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_company_id_tenants_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_charge_id_subscription_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."subscription_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_method_id_platform_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."platform_payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_payments_company_idx" ON "subscription_payments" USING btree ("company_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_one_in_review" ON "subscription_payments" USING btree ("company_id") WHERE "subscription_payments"."status" = 'in_review';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_reference_unique" ON "subscription_payments" USING btree ("method_id","reference") WHERE "subscription_payments"."status" <> 'rejected' and "subscription_payments"."reference" is not null and "subscription_payments"."method_id" is not null;--> statement-breakpoint
-- A company reads its own payments (its Suscripción → Pagos, and whether one in review covers its
-- debt); it never writes them: they are reported through our API, written as the platform.
ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscription_payments FOR SELECT TO tenant_scoped
  USING (company_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.subscription_payments FROM %I', api_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_scoped') THEN
    REVOKE ALL ON public.subscription_payments FROM tenant_scoped;
    GRANT SELECT ON public.subscription_payments TO tenant_scoped;
  END IF;
END $$;

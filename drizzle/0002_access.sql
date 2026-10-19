CREATE TABLE "membership_channels" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	CONSTRAINT "membership_channels_pkey" PRIMARY KEY("tenant_id","user_id","channel_account_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"can_see_others" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('admin', 'agent')),
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('invited', 'active', 'disabled')),
	CONSTRAINT "memberships_admin_sees_all_check" CHECK ("memberships"."role" <> 'admin' or "memberships"."can_see_others")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"platform_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_check" CHECK ("users"."email" = lower("users"."email") and "users"."email" like '%_@_%'),
	CONSTRAINT "users_platform_role_check" CHECK ("users"."platform_role" in ('super_admin'))
);
--> statement-breakpoint
ALTER TABLE "membership_channels" ADD CONSTRAINT "membership_channels_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_channels" ADD CONSTRAINT "membership_channels_channel_fk" FOREIGN KEY ("tenant_id","channel_account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_fk" FOREIGN KEY ("tenant_id","assigned_user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
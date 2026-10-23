CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"can_see_others" boolean DEFAULT false NOT NULL,
	"channel_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_email_check" CHECK ("invitations"."email" = lower("invitations"."email") and "invitations"."email" like '%_@_%'),
	CONSTRAINT "invitations_name_check" CHECK (length(trim("invitations"."name")) between 1 and 80),
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('admin', 'agent')),
	CONSTRAINT "invitations_admin_sees_all_check" CHECK ("invitations"."role" <> 'admin' or "invitations"."can_see_others")
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fk" FOREIGN KEY ("tenant_id","invited_by") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_email_key" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;
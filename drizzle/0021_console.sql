ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_fk";
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "industry" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "city" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
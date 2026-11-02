CREATE TABLE "conversation_assignees" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_assignees_pkey" PRIMARY KEY("tenant_id","conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_assignees" ADD CONSTRAINT "conversation_assignees_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignees" ADD CONSTRAINT "conversation_assignees_member_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_assignees_user_idx" ON "conversation_assignees" USING btree ("tenant_id","user_id");
CREATE TABLE "contact_tags" (
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "contact_tags_pkey" PRIMARY KEY("tenant_id","contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"mention_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_body_check" CHECK (length(trim("notes"."body")) between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tone" text DEFAULT 'neutral' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tags_tone_check" CHECK ("tags"."tone" in ('green', 'red', 'amber', 'blue', 'violet', 'neutral', 'pink', 'teal')),
	CONSTRAINT "tags_name_check" CHECK (length(trim("tags"."name")) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_fk" FOREIGN KEY ("tenant_id","tag_id") REFERENCES "public"."tags"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_fk" FOREIGN KEY ("tenant_id","author_user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_mention_fk" FOREIGN KEY ("tenant_id","mention_user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_tags_tag_idx" ON "contact_tags" USING btree ("tenant_id","tag_id");--> statement-breakpoint
CREATE INDEX "notes_conversation_created_idx" ON "notes" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_tenant_name_key" ON "tags" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_fk" FOREIGN KEY ("tenant_id","author_user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_check" CHECK (("messages"."author" = 'staff') = ("messages"."author_user_id" is not null));
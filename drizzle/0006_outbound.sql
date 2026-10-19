CREATE TABLE "channel_credentials" (
	"channel_account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "send_error" text;--> statement-breakpoint
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_channel_fk" FOREIGN KEY ("tenant_id","channel_account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_client_message_id_key" UNIQUE("tenant_id","client_message_id");
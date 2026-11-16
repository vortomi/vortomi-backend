ALTER TABLE "channel_credentials" ADD COLUMN "encrypted_two_step_pin" text;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN "coexistence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN "token_expires_at" timestamp with time zone;
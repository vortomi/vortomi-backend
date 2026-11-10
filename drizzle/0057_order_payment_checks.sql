ALTER TABLE "stock_movements" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "sha256" text GENERATED ALWAYS AS (encode(sha256(content), 'hex')) STORED;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "received_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_order_idx" ON "stock_movements" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "media_files_tenant_sha256_idx" ON "media_files" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_paid_reference_key" ON "orders" USING btree ("tenant_id","payment_method_id","payment_reference") WHERE "orders"."status" in ('confirmed', 'done') and "orders"."payment_reference" is not null;--> statement-breakpoint
CREATE INDEX "orders_tenant_confirmed_idx" ON "orders" USING btree ("tenant_id","confirmed_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_received_amount_check" CHECK ("orders"."received_amount" is null or "orders"."received_amount" > 0);--> statement-breakpoint
-- Orders sold before this change: their last change is the best guess of when they were confirmed.
UPDATE "orders" SET "confirmed_at" = "updated_at" WHERE "status" in ('confirmed', 'done');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_check" CHECK ("orders"."status" not in ('confirmed', 'done') or "orders"."confirmed_at" is not null);
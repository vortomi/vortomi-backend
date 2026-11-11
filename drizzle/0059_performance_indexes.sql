CREATE INDEX "message_status_events_sent_idx" ON "message_status_events" USING btree ("tenant_id","occurred_at") WHERE "message_status_events"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("tenant_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "messages_tenant_inbound_created_idx" ON "messages" USING btree ("tenant_id","created_at") WHERE "messages"."direction" = 'in';--> statement-breakpoint
CREATE INDEX "orders_conversation_created_idx" ON "orders" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_processed_idx" ON "webhook_events" USING btree ("processed_at") WHERE "webhook_events"."processed_at" is not null;
CREATE TABLE "catalog_sources" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_sources_kind_check" CHECK ("catalog_sources"."kind" in ('lacampina_v1')),
	CONSTRAINT "catalog_sources_base_url_check" CHECK ("catalog_sources"."base_url" ~ '^https://')
);
--> statement-breakpoint
ALTER TABLE "catalog_sources" ADD CONSTRAINT "catalog_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
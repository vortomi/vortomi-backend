-- The single "tasa del día" field becomes the first row of each company's rate history
-- (exchange_rates, 0026), dated the day it was last saved and with no author ("Sistema").
INSERT INTO "exchange_rates" ("tenant_id", "rate", "effective_date", "source", "created_at")
SELECT s."tenant_id", s."exchange_rate_ves", (s."updated_at" AT TIME ZONE t."timezone")::date, 'manual', s."updated_at"
  FROM "tenant_settings" s
  JOIN "tenants" t ON t."id" = s."tenant_id"
 WHERE s."exchange_rate_ves" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" DROP COLUMN "exchange_rate_ves";

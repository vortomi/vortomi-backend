ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_quantity_check";--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "on_hand" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "reserved" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "low_stock_threshold" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "min_quantity" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "min_quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "quantity_step" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "quantity_step" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "sale_unit" text DEFAULT 'unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sale_unit_check" CHECK ("order_lines"."sale_unit" in ('unit', 'pair', 'dozen', 'box', 'pack', 'roll', 'kg', 'g', 'm', 'm2', 'l', 'hour', 'service', 'session'));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quantity_check" CHECK ("order_lines"."quantity" > 0 and "order_lines"."quantity" <= 1000);
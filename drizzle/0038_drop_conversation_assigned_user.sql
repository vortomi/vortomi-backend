ALTER TABLE "conversations" DROP CONSTRAINT "conversations_assignee_fk";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "assigned_user_id";
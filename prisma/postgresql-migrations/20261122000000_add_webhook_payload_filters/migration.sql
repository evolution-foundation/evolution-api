-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "excludeFields" JSONB,
ADD COLUMN     "includeFields" JSONB;

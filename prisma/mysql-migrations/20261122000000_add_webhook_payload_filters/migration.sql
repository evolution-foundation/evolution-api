-- AlterTable
ALTER TABLE `Webhook` ADD COLUMN `excludeFields` JSON NULL,
    ADD COLUMN `includeFields` JSON NULL;

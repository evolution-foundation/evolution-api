-- Fail on existing duplicates rather than silently deleting or merging customer data.
CREATE UNIQUE INDEX `Label_labelId_instanceId_key` ON `Label`(`labelId`, `instanceId`);

-- Restore the field removed by the Kafka migration and used by the WhatsApp cache.
ALTER TABLE `IsOnWhatsapp` ADD COLUMN `lid` VARCHAR(100) NULL;

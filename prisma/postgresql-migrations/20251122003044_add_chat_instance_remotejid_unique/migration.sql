-- 1. Cleanup: Remove duplicate chats, keeping the most recently updated one
DELETE FROM "Chat"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "instanceId", "remoteJid"
             ORDER BY "updatedAt" DESC
           ) as row_num
    FROM "Chat"
  ) t
  WHERE t.row_num > 1
);

-- 2. Create the unique index (Constraint)
CREATE UNIQUE INDEX "Chat_instanceId_remoteJid_key" ON "Chat"("instanceId", "remoteJid");

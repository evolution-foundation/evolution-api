-- Index the message key (issue #2753).
--
-- "Message" had only its primary key and "instanceId", so every lookup by chat or by message id
-- read all messages of the instance. The key is filtered in two forms, and PostgreSQL uses an
-- expression index only for the same expression:
--   * Prisma JSON path filters (key: { path: ['remoteJid'], equals }) compile to "key" #> '{remoteJid}'.
--   * Raw queries (getMessage, messages.update, the read and unread updates, fetchChats and the
--     Chatwoot service) use "key"->>'id' and "key"->>'remoteJid'.
-- Prisma cannot declare expression indexes in the schema, so they live in this migration.
--
-- CONCURRENTLY keeps writes to "Message" going while each index builds. prisma migrate deploy runs
-- the statements of this file one by one, outside a transaction, so CONCURRENTLY is allowed here.
-- If a build fails part-way, PostgreSQL leaves an INVALID index under that name: drop it
-- (DROP INDEX CONCURRENTLY "<name>"), mark the migration rolled back and deploy again.

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyId_idx" ON "Message"("instanceId", ("key" ->> 'id'));

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyRemoteJid_idx" ON "Message"("instanceId", ("key" ->> 'remoteJid'));

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyIdPath_idx" ON "Message"("instanceId", ("key" #> '{id}'));

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyRemoteJidPath_idx" ON "Message"("instanceId", ("key" #> '{remoteJid}'));

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyRemoteJidAltPath_idx" ON "Message"("instanceId", ("key" #> '{remoteJidAlt}'));

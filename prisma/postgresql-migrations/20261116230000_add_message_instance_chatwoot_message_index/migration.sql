-- Single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside the
-- implicit transaction Postgres opens for a multi-statement query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_chatwootMessageId_idx" ON "Message"("instanceId", "chatwootMessageId");

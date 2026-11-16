-- Single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside the
-- implicit transaction Postgres opens for a multi-statement query.
-- Expression index, not representable in the Prisma schema.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyId_idx" ON "Message"("instanceId", (("key"->>'id')));

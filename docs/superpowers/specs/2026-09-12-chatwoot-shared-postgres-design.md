# Chatwoot with Evolution API on Shared PostgreSQL

## Goal

Add a self-hosted Chatwoot installation to the existing My Evolution Docker Compose deployment so operators can view and reply to private WhatsApp conversations from every connected Evolution instance. Group conversations must be ignored.

The existing Evolution instances, PostgreSQL data, Redis data, and WhatsApp sessions must survive the installation unchanged.

## Current State

- Evolution API runs from the locally built `evolution-api` image.
- PostgreSQL 15 stores the Evolution database in the named volume `evo_postgres_data`.
- Redis 7 stores Evolution cache and session state in `evo_redis_data`; Evolution uses Redis logical database 1.
- WhatsApp session files are stored in `evolution_instances`.
- Message, contact, chat, label, and history persistence are disabled in Evolution.
- Existing instances are already connected.
- `SERVER_URL` currently points to `http://localhost:8080`, which cannot be used by another container as an Evolution callback address.

## Architecture

The deployment will continue to use one PostgreSQL container and one PostgreSQL volume. The container will host two logically separate databases:

- `evolution`: the existing database and schema.
- `chatwoot`: a new database owned by the existing PostgreSQL role.

The PostgreSQL image will change from `postgres:15` to `pgvector/pgvector:pg15`. The PostgreSQL major version and data directory format remain PostgreSQL 15, so the existing named volume can be mounted without an in-place major-version upgrade. The `vector` extension will be enabled only in the `chatwoot` database.

Chatwoot will add two application services:

- `chatwoot-web`: Rails web/API server and browser interface.
- `chatwoot-worker`: Sidekiq background worker.

Both services will use the new `chatwoot` database. They will share the existing Redis container but use Redis logical database 2, while Evolution remains on logical database 1. Chatwoot attachments will use a dedicated named volume.

Only the Chatwoot web service and Evolution HTTP API may be exposed through Cloudflare Tunnel. PostgreSQL and Redis will have no published ports.

## Data Preservation and Rollback

The installation must not delete, recreate, rename, or reinitialize any existing named volume.

Before changing the PostgreSQL image, an installation script will:

1. Confirm that the current PostgreSQL container is healthy and accepts authenticated connections.
2. Create a timestamped custom-format `pg_dump` of the `evolution` database in a host-mounted backup directory.
3. Verify that the dump command succeeded and that the resulting file is non-empty.
4. Record the current Compose service state.

The operator will then stop application services, replace the PostgreSQL image, and restart PostgreSQL against the same volume. Validation must confirm that the `evolution` database, instance rows, and Evolution API are healthy before Chatwoot initialization proceeds.

Rollback consists of stopping services, restoring the original `postgres:15` image, and starting it with the same volume. Because both images use PostgreSQL 15, this does not require a database restore. The verified dump remains the recovery path if data-level recovery is ever needed.

## Chatwoot Initialization

Initialization will be explicit rather than hidden in the normal application startup:

1. Idempotently create the `chatwoot` database if it does not exist.
2. Enable the `vector` extension in that database.
3. Run `bundle exec rails db:chatwoot_prepare` using the Chatwoot image.
4. Start `chatwoot-web` and `chatwoot-worker`.
5. Verify the Chatwoot health endpoint before onboarding begins.

The initial deployment will pin the Community Edition image to `chatwoot/chatwoot:v4.17.1-ce`, the current security release verified during design. Upgrades must explicitly update the version and rerun `db:chatwoot_prepare` after a fresh backup.

## Configuration and Secrets

The checked-in example environment file will document all required variables. The real `.env` remains untracked and contains:

- A strong PostgreSQL password.
- A generated alphanumeric `SECRET_KEY_BASE` for Chatwoot.
- The public Chatwoot URL used by browsers through Cloudflare Tunnel.
- The externally reachable Evolution URL used in Chatwoot callback webhooks.
- Chatwoot mail configuration when outbound email is enabled.

`CHATWOOT_ENABLED=true` will be enabled globally in Evolution. Direct database import of old messages will remain disabled initially because Evolution currently does not persist message history and the primary requirement is handling new conversations safely.

The current sample credentials such as `masterkey` and `evolution` are not suitable for an Internet-accessible production service. Deployment instructions will require replacing them, without silently rotating live credentials during file generation.

## Cloudflare Tunnel

The recommended public routing is:

- `chat.<domain>` to `http://chatwoot-web:3000` when the tunnel runs in the Compose network, or to `http://localhost:3000` when `cloudflared` runs on the host.
- `evolution.<domain>` to `http://evolution-api:8080` when the tunnel runs in the Compose network, or to `http://localhost:8080` from the host.

`FRONTEND_URL` will contain the HTTPS Chatwoot URL. Evolution's `SERVER_URL` must contain its HTTPS public URL so the webhook created in Chatwoot is reachable and does not resolve to Chatwoot's own loopback interface.

## Existing Instance Integration

Linking happens after the operator creates the first Chatwoot administrator/account and obtains its API access token. An idempotent helper script will:

1. List all existing Evolution instances through the authenticated API.
2. Read each instance's current settings.
3. Update only `groupsIgnore` to `true` while preserving every other required setting.
4. Configure the native Evolution Chatwoot integration for each instance with a distinct inbox name.
5. Use `autoCreate=true` so Evolution creates the Chatwoot API inbox and webhook.
6. Default to no historical import and begin forwarding new private conversations.
7. Fetch and print the resulting integration status for every instance without printing the Chatwoot or Evolution tokens.

Group filtering happens inside Evolution before message persistence, webhook delivery, and Chatwoot forwarding for Baileys instances. Existing group data already present in either database is not deleted by this change.

## Failure Handling

- Database backup or validation failure stops installation before any image change.
- PostgreSQL startup failure stops Chatwoot initialization and triggers the documented rollback.
- Database creation and extension creation are idempotent.
- Failure to link one Evolution instance does not roll back successful links; the helper reports failures and can be rerun safely.
- Existing Evolution connectivity is checked before and after PostgreSQL changes.
- Chatwoot remains internal until onboarding and health checks succeed.

## Verification

The implementation will verify:

- Compose configuration renders successfully.
- The PostgreSQL 15 server opens the original volume and the `evolution` database remains readable.
- Existing instance count and connection states match the pre-change snapshot.
- The `chatwoot` database has the `vector` extension.
- Chatwoot web and worker services start without migration errors.
- A new direct WhatsApp message appears in the correct Chatwoot inbox.
- A Chatwoot agent reply is delivered to the originating WhatsApp contact.
- A new group message does not appear in Chatwoot.
- Container restarts do not lose Evolution sessions, Chatwoot conversations, or attachments.

## Files in Scope

- `my-evolution-api/docker-compose.yaml`
- `my-evolution-api/.env.example`
- A safe database backup/setup script under `my-evolution-api/scripts/`
- An idempotent existing-instance linking script under `my-evolution-api/scripts/`
- A short deployment/runbook document under `my-evolution-api/`

The live `.env` will only receive additions needed for local verification when values are known. Secret placeholders will not be treated as deployable credentials.

## Out of Scope

- Building a conversations UI inside My Evolution.
- Importing old WhatsApp history.
- Deleting previously stored group messages.
- Configuring DNS records or creating a Cloudflare Tunnel remotely.
- Automatically creating the first Chatwoot administrator or extracting a user token.
- Exposing PostgreSQL or Redis outside Docker.

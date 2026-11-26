#!/bin/bash
set -e

update_env() {
    local key="$1" value="$2"
    [ -z "$value" ] && return
    grep -qE "^${key}=" .env 2>/dev/null && \
        sed -i "s|^${key}=.*|${key}=${value}|" .env || \
        echo "${key}=${value}" >> .env
}

if [ -n "$DATABASE_PROVIDER" ]; then
    PROVIDER="$DATABASE_PROVIDER"
else
    PROVIDER=$(grep -E '^DATABASE_PROVIDER=' .env | head -1 | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' ')
fi

PROVIDER=$(echo "${PROVIDER:-postgresql}" | tr '[:upper:]' '[:lower:]')
[ "$PROVIDER" = "psql_bouncer" ] && PRISMA_PROVIDER="postgresql" || PRISMA_PROVIDER="$PROVIDER"

update_env "DATABASE_PROVIDER" "$DATABASE_PROVIDER"
update_env "DATABASE_ENABLED" "$DATABASE_ENABLED"
update_env "SERVER_PORT" "$SERVER_PORT"
update_env "AUTHENTICATION_API_KEY" "$AUTHENTICATION_API_KEY"
update_env "CACHE_REDIS_ENABLED" "$CACHE_REDIS_ENABLED"
update_env "CACHE_LOCAL_ENABLED" "$CACHE_LOCAL_ENABLED"

if [ -n "$DATABASE_CONNECTION_URI" ]; then
    update_env "DATABASE_CONNECTION_URI" "$DATABASE_CONNECTION_URI"
elif [ -n "$DATABASE_CONNECTION_URL" ]; then
    update_env "DATABASE_CONNECTION_URI" "$DATABASE_CONNECTION_URL"
elif [ -n "$DATABASE_URL" ]; then
    update_env "DATABASE_CONNECTION_URI" "$DATABASE_URL"
fi

DB_URI=$(grep -E '^DATABASE_CONNECTION_URI=' .env | head -1 | cut -d'=' -f2-)
[ -z "$DB_URI" ] && echo "ERRO: DATABASE_CONNECTION_URI não definido!" && exit 1

rm -rf ./prisma/migrations
cp -r "./prisma/${PRISMA_PROVIDER}-migrations" ./prisma/migrations

npx prisma migrate deploy --schema "./prisma/${PRISMA_PROVIDER}-schema.prisma"
echo "==> Migrations aplicadas!"

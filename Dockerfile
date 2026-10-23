# Pinned to a patched Node.js 24 LTS release (October 2026 security release,
# CVE-2026-111497). Keep tag and digest in sync when bumping.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl

LABEL version="2.3.1" description="Api to control whatsapp features through http requests." 
LABEL maintainer="Davidson Gomes" git="https://github.com/DavidsonGomes"
LABEL contact="contato@evolution-api.com"

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./
COPY ./patches ./patches

RUN npm ci --silent

RUN npx patch-package

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./.env.example ./.env
COPY ./runWithProvider.js ./

COPY ./Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*

RUN ./Docker/scripts/generate_database.sh

# Licensing endpoint is XOR-encoded into the bundle by tsup `define`. Pass the
# pair via build-args (NEVER as runtime env vars) to keep the URL out of the
# compiled JavaScript as a plain literal. Generate them with
# `node tools/encode-url.js <url>`. Leaving them empty is OK for non-release
# builds — the dev fallback in src/licensing/endpoint.ts kicks in.
ARG LICENSE_ENDPOINT_ENCODED
ARG LICENSE_ENDPOINT_XOR_KEY
ENV LICENSE_ENDPOINT_ENCODED=${LICENSE_ENDPOINT_ENCODED}
ENV LICENSE_ENDPOINT_XOR_KEY=${LICENSE_ENDPOINT_XOR_KEY}

RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build

FROM ${NODE_IMAGE} AS final

RUN apk update && \
    apk add tzdata ffmpeg bash openssl

ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json

COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts

ENV DOCKER_ENV=true

EXPOSE 8080

ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod" ]

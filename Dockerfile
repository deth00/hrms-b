FROM node:24-bookworm-slim AS base

# Prisma Linux engine requires OpenSSL
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app


# =========================
# Build
# =========================
FROM base AS build

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci
RUN npm run prisma:generate

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets

RUN npm run build


# =========================
# Production dependencies
# =========================
FROM build AS production-dependencies

RUN npm prune --omit=dev \
    && npm cache clean --force


# =========================
# Production
# =========================
FROM base AS production

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets

USER node

EXPOSE 4000

CMD ["node", "dist/server.js"]
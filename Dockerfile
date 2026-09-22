# Konstellation testnet-1 faucet. Deployment image only — this repo produces
# no release binary (ENGINEERING.md §5: `konstellation` is the one repo that
# does). The faucet key is NOT baked in: pass FAUCET_PRIVATE_KEY at runtime
# as a secret (see README.md "Key handling").
#
# The base image is pinned by digest (the multi-arch index of node:22-alpine).
# To bump: `docker buildx imagetools inspect node:22-alpine` → Digest.

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
# WITH_REDIS=1 keeps the optional `redis` client (RATE_LIMIT_STORE=redis, for
# more than one replica). The default image leaves it out: ~14 MB / 6
# packages that a single replica never loads.
ARG WITH_REDIS=0
WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ "$WITH_REDIS" = "1" ]; then npm ci --ignore-scripts; else npm ci --ignore-scripts --omit=optional; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && if [ "$WITH_REDIS" = "1" ]; then npm prune --omit=dev; else npm prune --omit=dev --omit=optional; fi

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]

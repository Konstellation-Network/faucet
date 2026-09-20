# Konstellation testnet-1 faucet. Deployment image only — this repo produces
# no release binary (ENGINEERING.md §5: `konstellation` is the one repo that
# does). The faucet key is NOT baked in: pass FAUCET_PRIVATE_KEY at runtime
# as a secret (see README.md "Key handling").

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
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

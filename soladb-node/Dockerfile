# SolaDB replicator node for Solana.  Build from the REPO ROOT (the node links
# the SDK as file:../sdk):
#
#   docker build -f soladb-node/Dockerfile -t soladb-node .
#
# Alpine: the rocksdb glibc prebuild crashes on Node 22; rocksdb ships a musl
# prebuild, so no compiler is needed.  The context allowlist lives in
# soladb-node/Dockerfile.dockerignore (read by BuildKit for this Dockerfile).
FROM node:22-alpine AS build

# 1. @soladb/sdk (dist + its runtime dependencies)
WORKDIR /app/sdk
COPY sdk/package.json sdk/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY sdk/src ./src
RUN npm run build && npm prune --omit=dev

# 2. The node; node_modules/@soladb/sdk links to ../sdk
WORKDIR /app/node
COPY soladb-node/package.json soladb-node/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY soladb-node/tsconfig.json soladb-node/tsconfig.build.json soladb-node/nest-cli.json ./
COPY soladb-node/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app/node
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    ROCKSDB_PATH=/app/data/rocksdb
# Same layout as the build stage, so the ../sdk link resolves
COPY --from=build /app/sdk/package.json /app/sdk/package.json
COPY --from=build /app/sdk/dist /app/sdk/dist
COPY --from=build /app/sdk/node_modules /app/sdk/node_modules
COPY --from=build /app/node/package.json ./
COPY --from=build /app/node/node_modules ./node_modules
COPY --from=build /app/node/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# Records worker. Zero runtime dependencies, so this is just Node plus the source.
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY records-worker.mjs seed-cache.mjs ./

# The warmed cache ships with the image so a public deployment can answer from
# disk immediately. Re-warm with `node seed-cache.mjs` (needs CACHE_ONLY unset).
COPY cache/ ./cache/

ENV PORT=8788
# Public deployments must not proxy visitor traffic onto the county's servers.
ENV CACHE_ONLY=1

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8788/health || exit 1

CMD ["node", "records-worker.mjs"]

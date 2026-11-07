# PureStrings in one container: the web app, the API, /mcp for assistants, /keys/ws for your keys, and the demo
# shop at /shop. Everything it keeps is in /data (purestrings.db, and the shop's shop.db beside it); mount a disk there.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/shop/package.json packages/shop/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build -w @purestrings/web

FROM node:24-slim
ENV NODE_ENV=production \
    PURESTRINGS_HOST=0.0.0.0 \
    PORT=7700 \
    PURESTRINGS_DB=/data/purestrings.db
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/shop/package.json packages/shop/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src
COPY packages/shop/src packages/shop/src
COPY packages/shop/catalog.json packages/shop/
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --chmod=755 entrypoint.sh /usr/local/bin/purestrings-entrypoint
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7700) + '/api/info').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Starts as root only to hand /data to the node user (a host's disk can be mounted root-owned), then runs as node.
ENTRYPOINT ["purestrings-entrypoint"]
CMD ["node", "--no-warnings", "packages/server/src/main.ts"]

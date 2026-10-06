# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    POSANDBOX_HOST=0.0.0.0 \
    POSANDBOX_HTTP_PORT=8100 \
    POSANDBOX_PRINTER_PORT=9100 \
    POSANDBOX_TERMINAL_PORT=8443 \
    POSANDBOX_POS_HOST=host.docker.internal \
    POSANDBOX_DATA_DIR=/data \
    POSANDBOX_STATIC_DIR=/app/dist
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY src/server src/server
COPY src/shared src/shared
COPY src/cli src/cli
COPY fonts fonts
COPY fixtures fixtures
COPY --from=build /app/dist dist
RUN mkdir -p /data && chown node:node /data && ln -s /app/src/cli/main.ts /usr/local/bin/posandbox
USER node
VOLUME /data
# 8100: panel and control API · 9100: virtual printer (raw TCP ESC/POS) · 8443: payment terminal (Terminal API, HTTPS)
EXPOSE 8100 9100 8443
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8100/api/health || exit 1
CMD ["node", "src/server/main.ts"]

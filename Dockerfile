# Mon carnet: the API server, which also serves the built web app. Used by Render (render.yaml)
# for the web service and the daily backup job.
FROM node:22-bookworm-slim

# PostgreSQL 17 client tools (pg_dump, pg_restore) for backups: new Supabase projects run PostgreSQL 17.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tar \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
# The web app's build reads PORT and BASE_PATH; the values only matter for its development server.
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/medichain run build \
 && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/artifacts/medichain/dist/public \
    PORT=10000
EXPOSE 10000
USER node
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

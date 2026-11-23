#!/bin/sh
# Starts the API server (which also serves the web app) in the Docker image.
# With SCHEMA_PUSH_ON_START=true it first brings the Supabase schema up to date and closes it to
# the public API (for hosts without a pre-deploy step, such as Render's free plan). If that fails,
# the server does not start: it never runs against a schema it does not match.
set -e
cd "$(dirname "$0")/.."
if [ "${SCHEMA_PUSH_ON_START:-false}" = "true" ]; then
  node lib/db/scripts/push.mjs
fi
exec node --enable-source-maps artifacts/api-server/dist/index.mjs

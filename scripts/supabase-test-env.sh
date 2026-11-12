#!/bin/sh
# Prints the environment for the API tests against the local Supabase stack started with
# `supabase start` in the repository root. Use: eval "$(scripts/supabase-test-env.sh)"
# SUPABASE_CLI can name the Supabase CLI binary (default: supabase on the PATH).
set -eu
cli="${SUPABASE_CLI:-supabase}"
status="$("$cli" status -o env 2>/dev/null)"
value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\(.*\)\"$/\1/p"; }
cat <<EOF
export TEST_DATABASE_URL='$(value DB_URL)'
export SUPABASE_URL='$(value API_URL)'
export SUPABASE_SECRET_KEY='$(value SECRET_KEY)'
export SUPABASE_PUBLISHABLE_KEY='$(value PUBLISHABLE_KEY)'
export SUPABASE_JWT_SECRET='$(value JWT_SECRET)'
EOF

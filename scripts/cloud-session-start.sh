#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): brings up what the gates need in a
# Claude Code cloud session. A local session exits at once, since it has
# docker-compose.dev.yml. Running services do not survive between cloud
# sessions, so this runs on every start and is idempotent.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Postgres with pgvector >= 0.8: lib/context/similar.ts sets
# hnsw.iterative_scan, which older pgvector rejects. Ubuntu 24.04's own
# postgresql-16-pgvector is older, so prefer the image CI and dev use, and
# fall back to the preinstalled Postgres 16 with pgvector from apt.postgresql.org
# (installed by the environment's setup script).
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  if docker info >/dev/null 2>&1; then
    docker start spaces-pg >/dev/null 2>&1 ||
      docker run -d --name spaces-pg -p 5432:5432 \
        -e POSTGRES_USER=spaces -e POSTGRES_PASSWORD=spaces -e POSTGRES_DB=spaces \
        pgvector/pgvector:pg17 >/dev/null
  else
    $SUDO service postgresql start
    $SUDO -u postgres psql -qtc "select 1 from pg_roles where rolname = 'spaces'" | grep -q 1 ||
      $SUDO -u postgres psql -qc "create role spaces login superuser password 'spaces'"
    $SUDO -u postgres psql -qtc "select 1 from pg_database where datname = 'spaces'" | grep -q 1 ||
      $SUDO -u postgres createdb -O spaces spaces
  fi
  for _ in $(seq 1 30); do
    pg_isready -h localhost -p 5432 -q && break
    sleep 1
  done
fi

corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

#!/bin/sh
set -e

# Migrations auto-run on every boot — no `docker exec` step, ever.
node_modules/.bin/tsx src/db/migrate.ts

ROLE="${ROLE:-all}"

case "$ROLE" in
  web)
    exec node .output/server/index.mjs
    ;;
  worker)
    exec node_modules/.bin/tsx src/worker/index.ts
    ;;
  all)
    # Two processes, one container: pg-boss worker + Nitro web server.
    # Web must never run CPU-bound extraction/embedding inline — that's
    # what the worker is for.
    node_modules/.bin/tsx src/worker/index.ts &
    WORKER_PID=$!
    node .output/server/index.mjs &
    WEB_PID=$!
    trap 'kill -TERM $WORKER_PID $WEB_PID 2>/dev/null' TERM INT
    wait $WEB_PID
    EXIT_CODE=$?
    kill -TERM $WORKER_PID 2>/dev/null || true
    exit $EXIT_CODE
    ;;
  *)
    echo "Unknown ROLE: $ROLE (expected web|worker|all)" >&2
    exit 1
    ;;
esac

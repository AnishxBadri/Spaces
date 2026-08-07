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
    #
    # Supervision contract (CONTEXT.md hostability #2): EITHER process dying
    # kills the container, so `restart: unless-stopped` heals it. Waiting on
    # the web PID alone left a crashed worker invisible — a "healthy"
    # container where extraction silently never runs. `wait -n` isn't in
    # busybox ash, so poll.
    node_modules/.bin/tsx src/worker/index.ts &
    WORKER_PID=$!
    node .output/server/index.mjs &
    WEB_PID=$!
    # EC distinguishes operator stop from crash: the trap is the one place
    # we know the shutdown was asked for — exit 0 there, 1 everywhere else,
    # so `docker ps -a` and on-failure restart policies read the truth.
    EC=1
    trap 'EC=0; kill -TERM $WORKER_PID $WEB_PID 2>/dev/null' TERM INT
    while kill -0 "$WORKER_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
      sleep 1
    done
    if [ "$EC" = 0 ]; then
      echo "[entrypoint] stopping on signal" >&2
    elif ! kill -0 "$WORKER_PID" 2>/dev/null; then
      echo "[entrypoint] worker exited — stopping container" >&2
    else
      echo "[entrypoint] web exited — stopping container" >&2
    fi
    kill -TERM $WORKER_PID $WEB_PID 2>/dev/null || true
    wait
    exit $EC
    ;;
  *)
    echo "Unknown ROLE: $ROLE (expected web|worker|all)" >&2
    exit 1
    ;;
esac

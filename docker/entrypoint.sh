#!/bin/sh
set -e

# Hostability contract #1 (CONTEXT.md): ./data ownership is fixed
# structurally, not by docs. Two phases — root repairs, then su-exec drops to
# UID 1000 and the same script runs again as the app user. Everything below
# the drop (migrate, the ROLE case, the supervision block) runs unprivileged.

DATA="${DATA_DIR:-/data}"
APP_UID=1000
APP_GID=1000

# --- Phase one: root -------------------------------------------------------
# Guarded so the re-exec falls straight through to phase two, and so an
# already-unprivileged start (compose `user: "1000:1000"`, rootless Podman)
# skips the repair instead of crashing on a chown it could never do.
if [ "${SPACES_DROPPED:-}" != 1 ] && [ "$(id -u)" = 0 ]; then
  if [ ! -d "$DATA" ] && ! mkdir -p "$DATA" 2>/dev/null; then
    echo "[entrypoint] cannot create $DATA" >&2
  fi

  # Only the top-level entry is inspected. A bind mount carries the host's
  # ownership, and that is what goes wrong; walking a 40 GB blob tree on
  # every boot to discover nothing is wrong is not a boot step.
  OWNER="$(stat -c '%u:%g' "$DATA" 2>/dev/null || echo unknown)"
  if [ "$OWNER" = "$APP_UID:$APP_GID" ]; then
    echo "[entrypoint] $DATA ownership already $OWNER — no repair needed" >&2
  else
    echo "[entrypoint] $DATA owned by $OWNER — repairing to $APP_UID:$APP_GID" >&2
    if chown -R "$APP_UID:$APP_GID" "$DATA" 2>/dev/null; then
      echo "[entrypoint] $DATA ownership repaired" >&2
    else
      # Read-only mount, or a container that only looks privileged. Say so
      # and let the write probe below print the actionable line.
      echo "[entrypoint] could not chown $DATA" >&2
    fi
  fi

  SPACES_DROPPED=1
  export SPACES_DROPPED
  exec su-exec "$APP_UID:$APP_GID" "$0" "$@"
fi

# --- Phase two: UID 1000 ---------------------------------------------------
# Write probe. Standing debt said the ownership landmine "fails at first
# upload, not at boot" — because dataDir() falls back to cwd and
# loadMasterKey() writes secret.key lazily. One touch turns that into a boot
# failure carrying its own fix.
PROBE="$DATA/.write-probe.$$"
if ! (touch "$PROBE" && rm -f "$PROBE") 2>/dev/null; then
  rm -f "$PROBE" 2>/dev/null || true
  echo "[entrypoint] $DATA is not writable by uid $(id -u):$(id -g)." >&2
  echo "[entrypoint] Blobs and secret.key would fail at first upload, so this is a boot failure." >&2
  echo "[entrypoint] Fix it on the host, then start again:  chown -R 1000:1000 ./data" >&2
  exit 1
fi

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

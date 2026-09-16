#!/bin/sh
# Backup — both-or-neither (CONTEXT.md hostability contract #5).
#
# The database and the blob directory are worthless apart: blobs are
# content-addressed sha256 files with no filenames, and the rows that name
# them live in Postgres. So this script produces ONE directory holding both,
# and deletes the whole directory if either half fails.
#
# Usage:  ./scripts/backup.sh [output-dir]     (default: ./backups)
# Cron:   0 3 * * *  cd /path/to/app && ./scripts/backup.sh
#
# Restore: docker compose exec -T db psql -U spaces spaces < dump.sql
#          tar xzf blobs.tgz
# Rollback after a bad upgrade is THIS, never an older image on a newer
# schema — migrations are forward-only.
set -eu

OUT_ROOT="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_ROOT/$STAMP"
DATA_DIR="${DATA_DIR:-./data}"

mkdir -p "$OUT"
cleanup_on_fail() {
  echo "[backup] failed — removing partial $OUT" >&2
  rm -rf "$OUT"
  exit 1
}
trap cleanup_on_fail INT TERM

if ! docker compose exec -T db pg_dump -U spaces spaces > "$OUT/dump.sql"; then
  cleanup_on_fail
fi

# secret.key rides along: without it every stored BYOK credential is
# unrecoverable. setup-token is transient and deliberately excluded.
if ! tar czf "$OUT/blobs.tgz" -C "$(dirname "$DATA_DIR")" \
    --exclude 'setup-token' "$(basename "$DATA_DIR")"; then
  cleanup_on_fail
fi

trap - INT TERM
echo "[backup] ok: $OUT ($(du -sh "$OUT" | cut -f1))"

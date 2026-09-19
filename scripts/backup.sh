#!/bin/sh
# Backup — both-or-neither (CONTEXT.md hostability contract #5).
#
# The database and the blob directory are worthless apart: blobs are
# content-addressed sha256 files with no filenames, and the rows that name
# them live in Postgres. So this script produces ONE directory holding both,
# and deletes the whole directory if either half fails.
#
# Usage:  ./scripts/backup.sh [output-dir] [options]   (default: ./backups)
#
#   --project NAME    compose project   (or COMPOSE_PROJECT_NAME)
#   --file FILE       compose file, repeatable (or COMPOSE_FILE) — point both
#                     scripts at the TLS overlay stack with
#                     --file docker-compose.yml --file docker-compose.tls.yml
#
# Env: DATA_DIR (default ./data), POSTGRES_USER / POSTGRES_DB (default spaces).
# Cron:   0 3 * * *  cd /path/to/app && ./scripts/backup.sh
#
# Restore: ./scripts/restore.sh <this-directory>. It is a script, not a
# recipe, because the two-line recipe that used to live here was wrong in
# three ways — it loaded into a live database, never dropped the old schema,
# and never put secret.key back at 0600 owned by 1000.
# Rollback after a bad upgrade is THAT, never an older image on a newer
# schema — migrations are forward-only.
set -eu

add_file() {
  COMPOSE_FILE="${COMPOSE_FILE:+$COMPOSE_FILE:}$1"
  export COMPOSE_FILE
}

die() {
  echo "[backup] $1" >&2
  exit 1
}

OUT_ROOT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      shift
      [ $# -gt 0 ] || die '--project needs a name'
      COMPOSE_PROJECT_NAME="$1"
      export COMPOSE_PROJECT_NAME
      ;;
    --project=*)
      COMPOSE_PROJECT_NAME="${1#--project=}"
      export COMPOSE_PROJECT_NAME
      ;;
    --file | -f)
      shift
      [ $# -gt 0 ] || die '--file needs a path'
      add_file "$1"
      ;;
    --file=*) add_file "${1#--file=}" ;;
    -*) die "unknown option $1" ;;
    *)
      [ -z "$OUT_ROOT" ] || die 'one output directory at a time'
      OUT_ROOT="$1"
      ;;
  esac
  shift
done

OUT_ROOT="${OUT_ROOT:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_ROOT/$STAMP"
DATA_DIR="${DATA_DIR:-./data}"
PGUSER_="${POSTGRES_USER:-spaces}"
PGDB="${POSTGRES_DB:-spaces}"
STARTED="$(date +%s)"

mkdir -p "$OUT"
cleanup_on_fail() {
  echo "[backup] failed — removing partial $OUT" >&2
  rm -rf "$OUT"
  exit 1
}
trap cleanup_on_fail INT TERM

if ! docker compose exec -T db pg_dump -U "$PGUSER_" "$PGDB" >"$OUT/dump.sql"; then
  cleanup_on_fail
fi

# secret.key rides along: without it every stored BYOK credential is
# unrecoverable. setup-token is transient and deliberately excluded.
if ! tar czf "$OUT/blobs.tgz" -C "$(dirname "$DATA_DIR")" \
  --exclude 'setup-token' "$(basename "$DATA_DIR")"; then
  cleanup_on_fail
fi

trap - INT TERM
# Sizes and seconds, separately: what a backup costs is a number the install
# doc quotes, and "total" hides which half is growing.
size() { wc -c <"$1" | tr -d ' '; }
echo "[backup] ok: $OUT (dump $(size "$OUT/dump.sql") bytes, blobs $(size "$OUT/blobs.tgz") bytes, $(($(date +%s) - STARTED))s)"
echo "[backup] restore it with: ./scripts/restore.sh $OUT"

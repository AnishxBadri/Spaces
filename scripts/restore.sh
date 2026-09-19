#!/bin/sh
# Restore — the other half of both-or-neither (CONTEXT.md hostability #5).
#
# A dump on its own is worthless: blobs are content-addressed files the
# database only names, and secret.key is the only thing that can decrypt a
# stored credential — without it every BYOK key in the vault is gone for good.
# So this script puts back BOTH halves or neither. The dump loads into a
# staging database and the archive unpacks into a staging directory; only
# when both have succeeded do they swap into place. Any failure before the
# swap leaves the target database and ./data exactly as they were.
#
# Usage:  ./scripts/restore.sh <backup-dir> [options]
#
#   --force           load even though the target database still holds data
#                     (the current database is kept aside, never dropped)
#   --project NAME    compose project   (or COMPOSE_PROJECT_NAME)
#   --file FILE       compose file, repeatable (or COMPOSE_FILE) — this is
#                     how the TLS overlay stack is addressed:
#                     --file docker-compose.yml --file docker-compose.tls.yml
#
# Env: DATA_DIR (default ./data), POSTGRES_USER / POSTGRES_DB (default spaces).
#
# Rollback after a bad upgrade is THIS, never an older image on a newer
# schema — migrations are forward-only and the boot guard refuses anyway.
set -eu

usage() {
  cat <<'USAGE'
Usage: ./scripts/restore.sh <backup-dir> [options]

  --force           load even though the target database still holds data
                    (the current database is kept aside, never dropped)
  --project NAME    compose project   (or COMPOSE_PROJECT_NAME)
  --file FILE       compose file, repeatable (or COMPOSE_FILE) — this is how
                    the TLS overlay stack is addressed:
                    --file docker-compose.yml --file docker-compose.tls.yml

Env: DATA_DIR (default ./data), POSTGRES_USER / POSTGRES_DB (default spaces).
USAGE
}

die() {
  echo "[restore] $1" >&2
  exit 1
}

add_file() {
  COMPOSE_FILE="${COMPOSE_FILE:+$COMPOSE_FILE:}$1"
  export COMPOSE_FILE
}

BACKUP=''
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
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
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $1 (--help for usage)" ;;
    *)
      [ -z "$BACKUP" ] || die 'one backup directory at a time'
      BACKUP="$1"
      ;;
  esac
  shift
done

[ -n "$BACKUP" ] || {
  usage >&2
  exit 2
}

DUMP="$BACKUP/dump.sql"
BLOBS="$BACKUP/blobs.tgz"
[ -d "$BACKUP" ] || die "no such backup directory: $BACKUP"
[ -f "$DUMP" ] || die "$DUMP is missing — that is not a backup.sh directory"
[ -f "$BLOBS" ] || die "$BLOBS is missing — that is not a backup.sh directory"

PGUSER_="${POSTGRES_USER:-spaces}"
PGDB="${POSTGRES_DB:-spaces}"
DATA_DIR="${DATA_DIR:-./data}"
PARENT="$(dirname "$DATA_DIR")"
BASE="$(basename "$DATA_DIR")"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE_DB="${PGDB}_restore_$STAMP"
STAGE_DIR="$PARENT/.restore-$STAMP"
KEPT_DB="${PGDB}_prerestore_$STAMP"
KEPT_DIR="$PARENT/$BASE.prerestore-$STAMP"

# The rename below has to run from a connection that is not inside the
# database being renamed, so `postgres` is the maintenance database.
[ "$PGDB" != postgres ] ||
  die 'POSTGRES_DB=postgres leaves no maintenance database to rename from'

abs() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "${1#./}" ;;
  esac
}

compose() { docker compose "$@"; }

# psql against the maintenance database — DDL about databases themselves.
maint() {
  compose exec -T db psql -v ON_ERROR_STOP=1 -qtAX \
    -U "$PGUSER_" -d postgres "$@"
}

# --- refusals, each naming what to do instead -------------------------------

if [ -n "$(compose ps --status running --quiet app 2>/dev/null || true)" ]; then
  echo '[restore] the app is running. Loading a dump underneath a live app' >&2
  echo '[restore] gives you a database half of one workspace and half of' >&2
  echo '[restore] another. Stop it first, then re-run this script:' >&2
  die "  docker compose stop app"
fi

compose up -d --wait --wait-timeout 120 db >/dev/null ||
  die 'the db service would not come up — nothing was changed'

OCCUPIED="$(
  compose exec -T db psql -qtAX -U "$PGUSER_" -d "$PGDB" \
    -c "select to_regclass('public.entity') is not null" 2>/dev/null || true
)"
if [ "$OCCUPIED" = t ] && [ "$FORCE" = 0 ]; then
  echo "[restore] $PGDB already holds a Spaces workspace (table \"entity\" is" >&2
  echo '[restore] there). Restoring on top of it would interleave two' >&2
  echo '[restore] different workspaces. Start from an empty volume:' >&2
  echo '[restore]   docker compose down -v      # deletes the database volume' >&2
  echo '[restore] or overwrite it deliberately — the current database is kept' >&2
  echo '[restore] aside, not dropped:' >&2
  die "  ./scripts/restore.sh $BACKUP --force"
fi

# --- staging: both halves land beside the target, not on it ----------------

cleanup_stage() {
  rm -rf "$STAGE_DIR" 2>/dev/null || true
  maint -c "drop database if exists \"$STAGE_DB\"" >/dev/null 2>&1 || true
}

fail() {
  echo "[restore] $1" >&2
  cleanup_stage
  echo "[restore] nothing was changed — $PGDB and $DATA_DIR are as they were" >&2
  exit 1
}

trap 'fail "interrupted"' INT TERM

echo "[restore] staging $BACKUP into $STAGE_DB and $STAGE_DIR"

maint -c "drop database if exists \"$STAGE_DB\"" >/dev/null ||
  fail "could not clear a stale staging database $STAGE_DB"
maint -c "create database \"$STAGE_DB\"" >/dev/null ||
  fail "could not create the staging database $STAGE_DB"

# --single-transaction: a dump that breaks half way leaves the staging
# database empty rather than partly loaded, and the swap never happens.
if ! compose exec -T db psql -v ON_ERROR_STOP=1 --single-transaction -q \
  -U "$PGUSER_" -d "$STAGE_DB" <"$DUMP" >/dev/null; then
  fail "the dump did not load — $DUMP is truncated or was taken from a different schema"
fi

mkdir -p "$STAGE_DIR" || fail "could not create $STAGE_DIR"
tar xzf "$BLOBS" -C "$STAGE_DIR" || fail "the blob archive did not unpack"
[ -d "$STAGE_DIR/$BASE" ] ||
  fail "$BLOBS has no $BASE/ directory — it was taken with a different DATA_DIR"

if [ -f "$STAGE_DIR/$BASE/secret.key" ]; then
  # 0600 and uid 1000: the key the container reads as the app user, and
  # nothing else on the box can read at all.
  chmod 600 "$STAGE_DIR/$BASE/secret.key" || fail 'could not chmod secret.key'
else
  echo '[restore] WARNING: no secret.key in this backup. That is only fine if' >&2
  echo '[restore] MASTER_KEY is set in the environment — otherwise every' >&2
  echo '[restore] stored credential is unrecoverable.' >&2
fi

# Ownership needs root. An operator running as root gets it directly; anyone
# else borrows it inside a container, the same trick the entrypoint uses.
if ! chown -R 1000:1000 "$STAGE_DIR/$BASE" 2>/dev/null; then
  compose run --rm -T --no-deps --user 0:0 --entrypoint sh \
    -v "$(abs "$STAGE_DIR/$BASE"):/restored" db -c \
    'set -e; chown -R 1000:1000 /restored
     if [ -f /restored/secret.key ]; then chmod 600 /restored/secret.key; fi' ||
    fail "could not give $BASE to uid 1000 — run this as root, or chown -R 1000:1000 $DATA_DIR afterwards"
fi

# --- the swap: both halves are proven, so neither can be left behind --------

echo '[restore] both halves staged — swapping them in'

DB_KEPT=0
if [ -n "$(maint -c "select 1 from pg_database where datname = '$PGDB'")" ]; then
  maint -c "alter database \"$PGDB\" rename to \"$KEPT_DB\"" >/dev/null ||
    fail "could not move $PGDB aside (something is still connected to it)"
  DB_KEPT=1
fi
if ! maint -c "alter database \"$STAGE_DB\" rename to \"$PGDB\"" >/dev/null; then
  [ "$DB_KEPT" = 0 ] ||
    maint -c "alter database \"$KEPT_DB\" rename to \"$PGDB\"" >/dev/null || true
  fail "could not rename $STAGE_DB into place"
fi

undo_db() {
  maint -c "alter database \"$PGDB\" rename to \"$STAGE_DB\"" >/dev/null || true
  [ "$DB_KEPT" = 0 ] ||
    maint -c "alter database \"$KEPT_DB\" rename to \"$PGDB\"" >/dev/null || true
}

DIR_KEPT=0
if [ -e "$DATA_DIR" ]; then
  if ! mv "$DATA_DIR" "$KEPT_DIR"; then
    undo_db
    fail "could not move $DATA_DIR aside"
  fi
  DIR_KEPT=1
fi
if ! mv "$STAGE_DIR/$BASE" "$DATA_DIR"; then
  [ "$DIR_KEPT" = 0 ] || mv "$KEPT_DIR" "$DATA_DIR" || true
  undo_db
  fail "could not move the restored tree into $DATA_DIR"
fi

rmdir "$STAGE_DIR" 2>/dev/null || true
trap - INT TERM

# An empty target database was scaffolding, not data — drop it. One that held
# a workspace (only reachable with --force) is kept until the operator says so.
if [ "$DB_KEPT" = 1 ] && [ "$OCCUPIED" != t ]; then
  maint -c "drop database if exists \"$KEPT_DB\"" >/dev/null || true
  DB_KEPT=0
fi

echo "[restore] ok: $PGDB and $DATA_DIR are back from $BACKUP"
echo '[restore] secret.key restored at 0600 owned by 1000 — the dump alone is worthless without it: the blobs it names are unreadable and every stored credential stays encrypted forever.'
if [ "$DB_KEPT" = 1 ]; then
  echo "[restore] the database that was there is kept as $KEPT_DB — drop it once you are happy:"
  echo "[restore]   docker compose exec -T db psql -U $PGUSER_ -d postgres -c 'drop database \"$KEPT_DB\"'"
fi
if [ "$DIR_KEPT" = 1 ]; then
  echo "[restore] the tree that was there is kept as $KEPT_DIR — delete it once you are happy."
fi
echo '[restore] next:  docker compose up -d'

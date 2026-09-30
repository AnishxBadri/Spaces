#!/usr/bin/env bash
# The upgrade path, both directions (SPA-189, ship-11): CI's `roundtrip` recipe
# with two images. Run by `.github/workflows/upgrade.yml` once per published
# tag in the matrix, and by hand against any two images.
#
#   scripts/upgrade-check.sh --from <old image> --to <new image> \
#     --old-fixture <roundtrip-fixture.mjs bundled from the old tag's checkout> \
#     --new-fixture <roundtrip-fixture.mjs bundled from this commit> \
#     --out <directory for logs and the summary> [--label <name>]
#     [--old-journal <dir>] [--new-journal <dir>]
#                             test knobs: a drizzle journal mounted over the
#                             old or the new image's, so the whole path can
#                             be exercised with two images built from the
#                             same tree — a synthetic "previous" image one
#                             migration short, or a synthetic "next" one
#                             migration ahead — before a real second tag is
#
# Both images must already be in the local daemon (the workflow pulls the
# tag and builds the commit); the compose override says `pull_policy: never`
# so nothing is fetched behind the check's back.
#
# What it proves, in order — each step is a named line in the log:
#
#   1. the OLD image boots against a fresh Postgres (the shipped compose file
#      plus an override naming the image), health says db ok and worker ok
#   2. a document, its blob and a credential are planted through the old
#      image — the fixture bundled from the old tag's own checkout, because
#      it inlines that tag's schema
#   3. scripts/backup.sh takes the backup the upgrade doc says to take
#   4. the NEW image boots against the same volume and the same ./data;
#      "migrations applied" is the journal, not a log line — the row count of
#      drizzle.__drizzle_migrations afterwards equals the new image's journal
#      length and is never less than before
#   5. health says db ok and worker ok, the blob downloads with the same
#      bytes, and the new fixture lists the document and decrypts the secret
#   6. the reverse: the OLD image against the upgraded database is refused
#      by the downgrade guard with its own sentence (copied from
#      packages/db/src/downgrade-guard.ts) — when the new image carries
#      migrations the old one lacks. When the two journals are the same
#      length there is nothing to refuse, the old image must boot, and the
#      log says so
#   7. scripts/restore.sh brings the pre-upgrade state back: the old image
#      boots, the migration count is what it was, the old fixture verifies
#
# On a failed upgrade boot the migration that broke is named: the first entry
# of the new image's journal that drizzle.__drizzle_migrations does not hold
# (drizzle applies in order and stops at the first error). Every container's
# log is written under --out whatever happens, for the workflow to attach.
set -euo pipefail

REMEDY='Restore the backup taken before the upgrade. An older image must never run against a newer schema, and there is no override.'

FROM='' TO='' OLD_FIXTURE='' NEW_FIXTURE='' OUT='' LABEL='' OLD_JOURNAL='' NEW_JOURNAL=''
COMPOSE_BASE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) shift; FROM="${1:?}" ;;
    --to) shift; TO="${1:?}" ;;
    --old-fixture) shift; OLD_FIXTURE="$(realpath "${1:?}")" ;;
    --new-fixture) shift; NEW_FIXTURE="$(realpath "${1:?}")" ;;
    --out) shift; OUT="${1:?}" ;;
    --label) shift; LABEL="${1:?}" ;;
    --old-journal) shift; OLD_JOURNAL="$(realpath "${1:?}")" ;;
    --new-journal) shift; NEW_JOURNAL="$(realpath "${1:?}")" ;;
    --compose) shift; COMPOSE_BASE="$(realpath "${1:?}")" ;;
    *) echo "upgrade-check: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
for v in FROM TO OLD_FIXTURE NEW_FIXTURE OUT; do
  [ -n "${!v}" ] || { echo "upgrade-check: --$(tr '[:upper:]_' '[:lower:]-' <<<"$v") is required" >&2; exit 2; }
done
[ -f "$OLD_FIXTURE" ] || { echo "upgrade-check: no such file $OLD_FIXTURE" >&2; exit 2; }
[ -f "$NEW_FIXTURE" ] || { echo "upgrade-check: no such file $NEW_FIXTURE" >&2; exit 2; }
[ -f "$COMPOSE_BASE" ] || { echo "upgrade-check: no compose file at $COMPOSE_BASE" >&2; exit 2; }
LABEL="${LABEL:-$(tr -c 'a-z0-9' '-' <<<"${FROM,,}" | sed 's/-*$//')}"

mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
WORK="$OUT/work"
LOG="$OUT/upgrade-check.log"
: >"$LOG"
mkdir -p "$WORK/data"

# Everything below runs in the work directory as one compose project, so the
# two operator scripts see exactly what an operator's directory holds: the
# shipped compose file (copied in, because compose resolves `./data` against
# the directory of the first file it is given), an override naming the
# image, ./data and ./backups.
cp "$COMPOSE_BASE" "$WORK/docker-compose.yml"
cd "$WORK"
export COMPOSE_PROJECT_NAME="upgrade-${LABEL}"
export COMPOSE_FILE="$WORK/docker-compose.yml:$WORK/image.yml"
export DATA_DIR="$WORK/data"
PGURL='postgresql://spaces:spaces@db:5432/spaces'

say() { printf '[upgrade] %s\n' "$*" | tee -a "$LOG"; }
fail() {
  say "FAILED: $*"
  collect_logs || true
  exit 1
}
# The blob tree and secret.key are 0600 owned by 1000: reading them needs
# root, which the runner has through sudo and a root shell has already.
root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
psqlq() { docker compose exec -T db psql -qtAX -U spaces -d spaces -c "$1"; }
applied_count() { psqlq 'select count(*) from drizzle.__drizzle_migrations'; }
applied_whens() { psqlq 'select created_at from drizzle.__drizzle_migrations order by created_at'; }
node_in() { docker run --rm --entrypoint node "$@"; }
# The journal an image boots with: its own, or the test knob's directory.
journal_dir_for() {
  if [ "$1" = "$FROM" ] && [ -n "$OLD_JOURNAL" ]; then echo "$OLD_JOURNAL"; fi
  if [ "$1" = "$TO" ] && [ -n "$NEW_JOURNAL" ]; then echo "$NEW_JOURNAL"; fi
}
journal_of() {
  # [{when, tag}] of an image's journal — or of the directory mounted over it.
  local dir
  dir="$(journal_dir_for "$1")"
  if [ -n "$dir" ]; then
    jq -c '[.entries[] | {when, tag}]' "$dir/meta/_journal.json"
  else
    node_in "$1" -e 'const j=JSON.parse(require("fs").readFileSync("/app/packages/db/drizzle/meta/_journal.json","utf8"));console.log(JSON.stringify(j.entries.map(e=>({when:e.when,tag:e.tag}))))'
  fi
}
use_image() {
  local dir
  dir="$(journal_dir_for "$1")"
  {
    echo 'services:'
    echo '  app:'
    echo "    image: $1"
    echo '    pull_policy: never'
    if [ -n "$dir" ]; then
      echo '    volumes:'
      echo "      - $dir:/app/packages/db/drizzle:ro"
    fi
  } >"$WORK/image.yml"
}
old_journal_mount=()
[ -z "$OLD_JOURNAL" ] || old_journal_mount=(-v "$OLD_JOURNAL:/app/packages/db/drizzle:ro")
health() { curl -fsS --max-time 5 http://localhost:3000/api/health 2>/dev/null || true; }
wait_health() {
  local deadline=$(( $(date +%s) + ${1:-240} )) h
  while [ "$(date +%s)" -lt "$deadline" ]; do
    h="$(health)"
    if jq -e '.db == "ok" and .worker.status == "ok"' <<<"$h" >/dev/null 2>&1; then
      say "health: $h"
      return 0
    fi
    sleep 3
  done
  say "health never reported db ok and worker ok — last answer: ${h:-none}"
  return 1
}
collect_logs() {
  docker compose logs --no-color app >"$OUT/${CURRENT_LOG:-app}.log" 2>&1 || true
  docker compose logs --no-color db >"$OUT/db.log" 2>&1 || true
}
sig() {
  # The presigned-blob signature, exactly as the app computes it.
  node -e 'const {createHmac}=require("crypto");const [k,v,e]=process.argv.slice(1);process.stdout.write(createHmac("sha256",Buffer.from(process.env.MASTER_KEY,"base64")).update(`blob:${v}:${k}:${e}`).digest("base64url"))' "$1" "$2" "$3"
}
blob_matches() {
  local exp s
  exp="$(( ($(date +%s) + 600) * 1000 ))"
  s="$(sig "$KEY" get "$exp")"
  curl -fsS -o "$WORK/got.bin" "http://localhost:3000/api/blob/$KEY?exp=$exp&sig=$s" || return 1
  cmp "$WORK/payload.bin" "$WORK/got.bin"
}
name_broken_migration() {
  # drizzle applies journal entries in order and stops at the first that
  # fails, so the first entry whose `when` has no row is the one that broke.
  local applied entry tag when
  applied="$(applied_whens 2>/dev/null | tr '\n' ' ')" || applied=''
  while IFS= read -r entry; do
    when="$(jq -r .when <<<"$entry")"
    tag="$(jq -r .tag <<<"$entry")"
    if ! grep -qw "$when" <<<" $applied "; then
      say "the migration that broke: $tag (journal when $when) — see $OUT/new-image.log"
      echo "::error::upgrade from $FROM: migration $tag did not apply (both containers' logs are attached)"
      return 0
    fi
  done < <(jq -c '.[]' <<<"$NEW_ENTRIES")
  say "every entry of the new journal is recorded, so the boot failed after migrate — see $OUT/new-image.log"
}
teardown() {
  collect_logs || true
  docker compose down -v >/dev/null 2>&1 || true
  docker rm -f "upgrade-${LABEL}-rollback" >/dev/null 2>&1 || true
}
trap teardown EXIT

STARTED=$(date +%s)
say "from $FROM to $TO — project $COMPOSE_PROJECT_NAME, work dir $WORK"
OLD_ENTRIES="$(journal_of "$FROM")"
NEW_ENTRIES="$(journal_of "$TO")"
OLD_LEN="$(jq length <<<"$OLD_ENTRIES")"
NEW_LEN="$(jq length <<<"$NEW_ENTRIES")"
say "journal: the old image knows $OLD_LEN migrations, the new image knows $NEW_LEN"
[ "$NEW_LEN" -ge "$OLD_LEN" ] || fail "the new image's journal is shorter than the old one's — that is a downgrade, not an upgrade"

# --- 1. the old image, fresh -------------------------------------------------
CURRENT_LOG=old-image
use_image "$FROM"
say "step 1: booting $FROM against a fresh Postgres"
docker compose up -d --wait --wait-timeout 300 >>"$LOG" 2>&1 || fail "the old image did not come up healthy"
wait_health || fail "the old image never reported db ok and worker ok"
BEFORE="$(applied_count)"
[ "$BEFORE" = "$OLD_LEN" ] || fail "the old image applied $BEFORE migrations but its journal has $OLD_LEN"
say "step 1: $BEFORE migrations applied by the old image"
NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q db)")"

# --- 2. plant under the old image ----------------------------------------------
say "step 2: planting a document, its blob and a credential through the old image"
root test -f "$WORK/data/secret.key" || fail "the old image did not generate ./data/secret.key"
MASTER_KEY="$(root cat "$WORK/data/secret.key" | tr -d '\n')"
export MASTER_KEY
head -c 65536 /dev/urandom >"$WORK/payload.bin"
KEY="$(sha256sum "$WORK/payload.bin" | cut -d' ' -f1)"
SECRET="sk-upgrade-$(openssl rand -hex 8)"
EXP="$(( ($(date +%s) + 600) * 1000 ))"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$WORK/payload.bin" \
  "http://localhost:3000/api/blob/$KEY?exp=$EXP&sig=$(sig "$KEY" put "$EXP")")"
[ "$CODE" = 201 ] || fail "the presigned PUT answered $CODE, not 201"
docker compose cp "$OLD_FIXTURE" app:/app/fixture.mjs >>"$LOG" 2>&1
docker compose exec -T app node /app/fixture.mjs plant --blob="$KEY" --size="$(stat -c%s "$WORK/payload.bin")" --secret="$SECRET" 2>&1 | tee -a "$LOG"
blob_matches || fail "the blob did not download intact under the old image"
say "step 2: planted, and the blob downloads with matching bytes"

# --- 3. the backup the upgrade doc says to take ----------------------------------
say "step 3: scripts/backup.sh"
T0=$(date +%s%3N)
root env COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" DATA_DIR="$DATA_DIR" \
  "$SCRIPTS/backup.sh" "$WORK/backups" 2>&1 | tee -a "$LOG"
BACKUP_MS=$(( $(date +%s%3N) - T0 ))
BACKUP_DIR="$(ls -d "$WORK"/backups/*/ | tail -1)"
BACKUP_DIR="${BACKUP_DIR%/}"
[ -f "$BACKUP_DIR/dump.sql" ] && [ -f "$BACKUP_DIR/blobs.tgz" ] || fail "backup.sh left no dump.sql + blobs.tgz"
collect_logs

# --- 4. the new image against the same volume ------------------------------------
CURRENT_LOG=new-image
say "step 4: booting $TO against the same volume and the same ./data"
docker compose stop app >>"$LOG" 2>&1
use_image "$TO"
T0=$(date +%s%3N)
if ! docker compose up -d --wait --wait-timeout 300 >>"$LOG" 2>&1 || ! wait_health; then
  name_broken_migration
  fail "the new image did not come up healthy against the upgraded database"
fi
UPGRADE_MS=$(( $(date +%s%3N) - T0 ))
AFTER="$(applied_count)"
say "step 4: migrations $BEFORE → $AFTER (the new image's journal has $NEW_LEN)"
[ "$AFTER" -ge "$BEFORE" ] || fail "the migration count went down ($BEFORE → $AFTER)"
[ "$AFTER" = "$NEW_LEN" ] || { name_broken_migration; fail "the database has $AFTER migrations but the new image's journal has $NEW_LEN"; }

# --- 5. the document survived --------------------------------------------------
say "step 5: the seeded document under the new image"
blob_matches || fail "the blob did not download with matching bytes after the upgrade"
docker compose cp "$NEW_FIXTURE" app:/app/fixture.mjs >>"$LOG" 2>&1
docker compose exec -T app node /app/fixture.mjs verify --blob="$KEY" --secret="$SECRET" 2>&1 | tee -a "$LOG"
say "step 5: listed, bytes match, credential decrypts"
collect_logs

# --- 6. the reverse: the old image against the upgraded database ------------------
say "step 6: the old image against the upgraded database"
docker compose stop app >>"$LOG" 2>&1
mkdir -p "$WORK/olddata"
set +e
REFUSAL="$(timeout 180 docker run --rm --network "$NET" -e DATABASE_URL="$PGURL" \
  "${old_journal_mount[@]}" -v "$WORK/olddata:/data" "$FROM" 2>&1 &
  PID=$!
  # A boot that gets as far as listening is a boot; stop it there.
  for _ in $(seq 1 60); do
    sleep 3
    kill -0 "$PID" 2>/dev/null || break
    docker ps --filter "ancestor=$FROM" --filter "network=$NET" -q | while read -r c; do
      docker logs "$c" 2>&1 | grep -q 'Listening' && docker stop "$c" >/dev/null 2>&1
    done
  done
  wait "$PID")"
REFUSED=$?
set -e
printf '%s\n' "$REFUSAL" >"$OUT/old-image-refused.log"
if [ "$NEW_LEN" -gt "$OLD_LEN" ]; then
  [ "$REFUSED" -ne 0 ] || fail "the old image booted against a database it should have refused"
  grep -F -- "$REMEDY" <<<"$REFUSAL" >/dev/null ||
    fail "the old image exited $REFUSED without the downgrade guard's sentence — see $OUT/old-image-refused.log"
  say "step 6: refused — $(grep -F '[migrate]' <<<"$REFUSAL" | head -1)"
  REVERSE='refused by the downgrade guard, with its own sentence'
else
  grep -qF 'Restore the backup taken' <<<"$REFUSAL" && fail "the guard refused two images with the same journal"
  grep -qE 'Listening|\[migrate\] up to date' <<<"$REFUSAL" ||
    fail "the old image neither refused nor booted — see $OUT/old-image-refused.log"
  say "step 6: no schema change between the two images, so nothing for the guard to refuse; the old image booted against the upgraded database (the refusal is asserted only when the new journal is longer)"
  REVERSE='no schema change: nothing to refuse, the old image boots'
fi

# --- 7. restore brings the pre-upgrade state back --------------------------------
CURRENT_LOG=old-image-restored
say "step 7: scripts/restore.sh $BACKUP_DIR --force (the database still holds the upgraded workspace)"
T0=$(date +%s%3N)
root env COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" DATA_DIR="$DATA_DIR" \
  "$SCRIPTS/restore.sh" "$BACKUP_DIR" --force 2>&1 | tee -a "$LOG"
RESTORE_MS=$(( $(date +%s%3N) - T0 ))
[ "$(root cat "$WORK/data/secret.key" | tr -d '\n')" = "$MASTER_KEY" ] || fail "secret.key did not come back"
use_image "$FROM"
docker compose up -d --wait --wait-timeout 300 >>"$LOG" 2>&1 || fail "the old image did not come up after the restore"
wait_health || fail "the old image never reported db ok and worker ok after the restore"
RESTORED="$(applied_count)"
[ "$RESTORED" = "$BEFORE" ] || fail "after the restore the database has $RESTORED migrations, not the $BEFORE it had before the upgrade"
blob_matches || fail "the blob did not download with matching bytes after the restore"
docker compose cp "$OLD_FIXTURE" app:/app/fixture.mjs >>"$LOG" 2>&1
docker compose exec -T app node /app/fixture.mjs verify --blob="$KEY" --secret="$SECRET" 2>&1 | tee -a "$LOG"
say "step 7: restored — $RESTORED migrations, the document lists, the bytes match, the credential decrypts"
collect_logs

TOTAL=$(( $(date +%s) - STARTED ))
{
  echo "### Upgrade $FROM → $TO"
  echo
  echo '| step | result |'
  echo '| --- | --- |'
  echo "| old image boots, migrations applied | $BEFORE (journal $OLD_LEN) |"
  echo "| backup.sh | $(stat -c%s "$BACKUP_DIR/dump.sql") B dump, $(stat -c%s "$BACKUP_DIR/blobs.tgz") B blobs, ${BACKUP_MS} ms |"
  echo "| new image boots, migrations applied | $BEFORE → $AFTER (journal $NEW_LEN), healthy in ${UPGRADE_MS} ms |"
  echo '| seeded document after the upgrade | listed, bytes match, credential decrypts |'
  echo "| old image against the upgraded database | $REVERSE |"
  echo "| restore.sh, old image again | ${RESTORE_MS} ms; $RESTORED migrations, listed, bytes match, credential decrypts |"
  echo "| wall clock | ${TOTAL} s |"
} | tee "$OUT/summary.md" >>"$LOG"
say "ok: $FROM → $TO → refused/restored in ${TOTAL}s (summary: $OUT/summary.md)"

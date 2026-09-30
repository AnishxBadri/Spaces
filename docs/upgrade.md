# Upgrade and rollback

Three commands, in this order: back up, change the tag, pull and up. The
order is enforced, not requested. An image refuses to start against a
database that a newer image has already migrated, so the backup you take
first is the only way back.

Every command on this page was run, in this order, on a machine holding only
the compose file and the two scripts from [install.md](install.md).

## 1. Back up first

```bash
sudo ./scripts/backup.sh
```

```
[backup] ok: ./backups/20260929-204042 (dump 148241 bytes, blobs 213 bytes, 0s)
[backup] restore it with: ./scripts/restore.sh ./backups/20260929-204042
```

Keep the directory name; the rollback below takes it as its argument. The
archive carries `secret.key` alongside the blobs.
**Lose `./data/secret.key` and every stored credential is unrecoverable.**

## 2. Change the tag

Upgrading is editing one line in `docker-compose.yml`:

```yaml
image: ghcr.io/anishxbadri/spaces:0.1.0
```

Set it to the release you want. Releases are published as the exact version
(`0.1.0`) and the major.minor (`0.1`); there is no `latest`. Pinning the
exact version means an upgrade only ever happens when you edit this line.
If you use the TLS or split overlay, change the same line there too; each
overlay spells the image out so it stands on its own.

## 3. Pull and up

```bash
docker compose pull && docker compose up -d
```

Under an overlay, the same two flags as always:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml pull && \
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Migrations run on boot, before either process serves traffic; there is no
`docker exec` step. Confirm with the log and the health endpoint:

```bash
docker compose logs app | grep -E "\[migrate\]|Listening"
curl -fsS http://localhost:3000/api/health
```

```
app-1  | [migrate] up to date
app-1  | ➜ Listening on: http://localhost:3000/ (all interfaces)
{"status":"ok","db":"ok","worker":{"status":"ok","lastBeatSeconds":9}}
```

## Why the backup is not optional

**An older image refuses a newer database. The way back from a bad upgrade is
restoring the backup you took before it, never a downgrade.**

Migrations are forward-only. If you set the tag back to the previous release
after its successor has migrated the database, the boot stops before
anything touches the database, with this in the log:

```
[migrate] database has 43 migrations, this image knows 42 — newest unknown: applied 2026-10-14T09:12:41.000Z (created_at 1760433161000, hash 3f9c2a1b7d4e). Restore the backup taken before the upgrade. An older image must never run against a newer schema, and there is no override.
[migrate] 1 of the database's migrations are not in this image's journal.
```

The counts, the timestamp and the hash are whatever they are on your box;
the sentence is always the same, and there is deliberately no environment
variable that skips it. An old image against a new schema would start, apply
nothing, and read columns that no longer mean what it thinks.

## Rollback

Stop the app, put the previous tag back in `docker-compose.yml`, restore,
start. `restore.sh` refuses to load a dump underneath a running app and
refuses to overwrite a database that still holds a workspace unless you say
so, which after an upgrade is exactly the situation:

```bash
docker compose stop app
sudo ./scripts/restore.sh ./backups/20260929-204042 --force
docker compose up -d
```

```
[restore] staging backups/20260929-204042 into spaces_restore_20260929-204058 and ./.restore-20260929-204058
[restore] both halves staged — swapping them in
[restore] ok: spaces and ./data are back from backups/20260929-204042
[restore] secret.key restored at 0600 owned by 1000 — the dump alone is worthless without it: the blobs it names are unreadable and every stored credential stays encrypted forever.
[restore] the database that was there is kept as spaces_prerestore_20260929-204058 — drop it once you are happy:
[restore]   docker compose exec -T db psql -U spaces -d postgres -c 'drop database "spaces_prerestore_20260929-204058"'
[restore] the tree that was there is kept as ./data.prerestore-20260929-204058 — delete it once you are happy.
[restore] next:  docker compose up -d
```

The dump loads into a staging database and the archive unpacks into a
staging directory; only when both have succeeded do they swap into place,
so a failure before the swap leaves the box exactly as it was. With
`--force` the database and `./data` that were there are kept beside the
restored ones, never dropped; delete them with the two lines the script
prints once you have looked at the restored workspace.

After a total loss (a dead disk, a deleted volume) there is nothing to
force past. Restore into the empty box and start:

```bash
docker compose down -v
sudo rm -rf ./data
sudo ./scripts/restore.sh ./backups/20260929-204042
docker compose up -d
```

The scripts address an overlay stack with `--file`, the same way you start
it: `sudo ./scripts/restore.sh ./backups/<stamp> --file docker-compose.yml --file docker-compose.tls.yml`.

## Installs from before the rename

An install from before the project was renamed has a Postgres role and
database called `dealos`, in a volume called `dealos_dealos_pgdata`. Both
lines below were run against exactly that shape. Keep the old volume and
rename what is inside it; nothing is copied.

Tell the new compose file to use the old volume, in a
`docker-compose.override.yml` beside it (Compose reads that file on its
own):

```yaml
volumes:
  spaces_pgdata:
    name: dealos_dealos_pgdata
    external: true
```

Put your existing password in `.env`; renaming a role keeps its password:

```
POSTGRES_PASSWORD=<your old POSTGRES_PASSWORD, default was dealos>
```

Start only the database, as the old role, and rename. Postgres will not
rename the role you are connected as, so a helper role does it and is
dropped after:

```bash
POSTGRES_USER=dealos POSTGRES_DB=dealos docker compose up -d db
docker compose exec -T db psql -U dealos -d postgres -c "create role spaces_rename login superuser"
docker compose exec -T db psql -U spaces_rename -d postgres -c "alter role dealos rename to spaces" -c "alter database dealos rename to spaces"
docker compose exec -T db psql -U spaces -d postgres -c "drop role spaces_rename"
```

Then a plain `docker compose up -d` starts the whole stack under the new
names, and the app finds its tables where it left them.

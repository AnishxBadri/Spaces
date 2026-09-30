---
layout: ../../layouts/Docs.astro
eyebrow: Docs · Self-host
title: Self-host Spaces
description: Two containers, one directory, about five minutes. What you need, the compose file, first run, HTTPS, backups, upgrades and every setting the app reads.
---

## Requirements

- **Docker** with the Compose plugin (`docker compose`, not the old `docker-compose`).
- **A box.** Any Linux machine or VM, amd64 or arm64. One image is published for both.
- **A domain, optionally.** Without one, Spaces serves plain HTTP on port 3000, which is fine on a laptop or a LAN. With one, the Caddy overlay below gets and renews a certificate for you.

Migrations run on every boot, so there is no `docker exec` step, now or at upgrade time.

## The compose file

Make a directory for the install and fetch the compose file into it:

```sh
mkdir spaces && cd spaces
curl -O https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.yml
```

This is the whole file, less its comments:

```yaml
name: spaces
services:
  app:
    image: ghcr.io/anishxbadri/spaces:0.1.0
    ports:
      - '3000:3000'
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-spaces}:${POSTGRES_PASSWORD:-spaces}@db:5432/${POSTGRES_DB:-spaces}
      APP_URL: ${APP_URL:-http://localhost:3000}
      # MASTER_KEY:
      # STORAGE_DRIVER: local
    volumes:
      - ./data:/data
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-spaces}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-spaces}
      POSTGRES_DB: ${POSTGRES_DB:-spaces}
    volumes:
      - spaces_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U spaces -d spaces']
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  ollama:
    image: ollama/ollama
    profiles: ['ollama']
    volumes:
      - ollama_models:/root/.ollama
    restart: unless-stopped

volumes:
  spaces_pgdata:
  ollama_models:
```

Two containers start: `app`, which runs the web server and the background worker, and `db`, Postgres 17 with pgvector. Postgres is not published on the host. The third service, `ollama`, starts only when you ask for it.

Settings go in a `.env` file beside the compose file, which Compose reads on its own. Set a database password before the first boot, because Postgres takes it from the environment only when it creates the volume:

```sh
POSTGRES_PASSWORD=choose-a-long-random-string
APP_URL=http://localhost:3000
```

The image is signed. To check it before you run it, see [the architecture page](/docs/architecture#the-image).

## First run

```sh
docker compose up -d
docker compose logs app | grep setup
```

The app prints a one-time setup token on its first boot:

```
[setup] First-run setup token: 3f9c…
[setup] Open /setup and enter it to create the admin account.
```

Open `http://localhost:3000/setup` (or your `APP_URL` followed by `/setup`), paste the token, and create the admin account and the workspace name. Demo data is optional. Setup takes under a minute.

The token works once. After the first account exists, signup closes and everyone else joins by invite. Invites are copyable links, so no mail server is needed.

Until that first account exists, `/setup` answers anyone who can reach port 3000, and the token is all that guards it. On a public box, finish setup straight away, or bring the HTTPS overlay up first, since it stops publishing port 3000.

## HTTPS

The app never terminates TLS. A reverse proxy always sits in front, and `APP_URL` alone decides the scheme, the cookies and every link the app builds. Caddy is the worked example, shipped as an overlay. Fetch the overlay and its Caddyfile:

```sh
curl -O https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.tls.yml
mkdir -p docker
curl -o docker/Caddyfile https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker/Caddyfile
```

Point an A or AAAA record at the box, open ports 80 and 443, then:

```sh
SPACES_DOMAIN=deals.example.com \
APP_URL=https://deals.example.com \
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Port 80 is not optional. It carries the ACME challenge and the redirect to HTTPS. Caddy issues and renews the certificate itself, and the overlay stops publishing port 3000 on the host.

Every boot logs what it decided, before it serves traffic:

```
[boot] external origin https://deals.example.com · cookies secure: yes · presign origin https://deals.example.com
```

> **Set `APP_URL` to the scheme and host the browser sees.** An `http://` `APP_URL` behind an HTTPS proxy fails silently. The login form posts, the session cookie is set without the `Secure` flag, the browser drops it, and you land back on the login page with no error. Boot warns when `APP_URL` is `http://` on a host that is not localhost.

### nginx, Traefik or anything else

Nothing here is specific to Caddy. Another proxy needs two things: a correct `APP_URL`, and a plain-HTTP upstream to the app container on port 3000 with the host port left unpublished. The app reads no forwarded headers at all, so a spoofed `X-Forwarded-Proto` cannot change a link, a cookie or a redirect.

If TLS already ends further upstream (a load balancer, or Cloudflare in full-strict mode), the Caddyfile carries a commented `:80` variant that proxies without issuing a certificate. `APP_URL` still says `https://`.

## Backup and restore

Spaces keeps its state in two places: the Postgres volume and the `./data` directory. `./data` holds the uploaded files, stored by content hash, and `secret.key`, the key every stored credential is encrypted under. Neither half is any use without the other, so you back them up together and restore them together.

**Back up `./data` and a `pg_dump` together, every time. Losing `secret.key` loses every stored credential for good: every API key in the vault stays encrypted forever.**

Two scripts do this properly. Fetch them next to the compose file:

```sh
mkdir -p scripts
curl -o scripts/backup.sh https://raw.githubusercontent.com/AnishxBadri/Spaces/main/scripts/backup.sh
curl -o scripts/restore.sh https://raw.githubusercontent.com/AnishxBadri/Spaces/main/scripts/restore.sh
chmod +x scripts/*.sh
```

### Backup

```sh
./scripts/backup.sh            # writes ./backups/<timestamp>/
```

Each backup is one directory holding `dump.sql` and `blobs.tgz` (all of `./data`, `secret.key` included). If either half fails, the script deletes the whole directory rather than leave you half a backup. It prints the size of each half and the time it took. From cron:

```sh
0 3 * * *  cd /path/to/spaces && ./scripts/backup.sh
```

On the HTTPS stack, pass both compose files: `--file docker-compose.yml --file docker-compose.tls.yml`. Copy `./backups` off the box; a backup on the same disk is not a backup.

### Restore

```sh
docker compose stop app
./scripts/restore.sh backups/20260930-030000
docker compose up -d
```

The restore loads the dump into a staging database and unpacks the archive into a staging directory. Only when both have succeeded does it swap them into place, so a failure part-way leaves your database and `./data` exactly as they were. It refuses to run while the app is up, and it refuses a database that already holds a workspace unless you pass `--force`; with `--force`, the database that was there is renamed aside, not dropped. It puts `secret.key` back at mode 0600, owned by uid 1000.

## Upgrade

Upgrading is changing the pinned tag on purpose, after a backup:

1. `./scripts/backup.sh`
2. Change `image: ghcr.io/anishxbadri/spaces:0.1.0` to the next release tag.
3. `docker compose pull && docker compose up -d`

Migrations run on boot. They are forward-only, so rollback is a restore of the backup from step 1, never an older image on a newer schema; the boot guard refuses that combination anyway.

Never use `latest`. No such tag is published. Releases are tagged with the exact version (`0.1.0`) and with major.minor (`0.1`); `0.1` moves with patch releases and is the most you should float on.

## Settings

Only `DATABASE_URL` and `APP_URL` are required, and the compose file sets both. Everything else has a working default.

| Variable               | Default                     | What it does                                                                                                                                |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | set by compose              | Postgres connection string. Required.                                                                                                       |
| `APP_URL`              | `http://localhost:3000`     | The origin the browser sees. Decides the scheme, cookie security and every link and presigned URL. Required.                                |
| `MASTER_KEY`           | `/data/secret.key`          | Base64 of 32 random bytes (`openssl rand -base64 32`). Without it, the app generates `secret.key` on first boot. Back up whichever you use. |
| `BETTER_AUTH_SECRET`   | derived from the master key | Session-signing secret, if you want to rotate it separately from the master key.                                                            |
| `STORAGE_DRIVER`       | `local`                     | `local` keeps uploads under `./data`. `s3` sends them to an S3-compatible bucket, for hosts with ephemeral disks.                           |
| `S3_BUCKET`            | none                        | Required when `STORAGE_DRIVER=s3`.                                                                                                          |
| `S3_ACCESS_KEY_ID`     | none                        | Required when `STORAGE_DRIVER=s3`.                                                                                                          |
| `S3_SECRET_ACCESS_KEY` | none                        | Required when `STORAGE_DRIVER=s3`.                                                                                                          |
| `S3_ENDPOINT`          | AWS                         | The endpoint for R2, B2, MinIO or Garage, e.g. `https://<account>.r2.cloudflarestorage.com`. Leave unset for AWS.                           |
| `S3_REGION`            | `us-east-1`                 | `auto` works for R2.                                                                                                                        |
| `S3_FORCE_PATH_STYLE`  | `true`                      | Right for R2, B2, MinIO and Garage. Set `false` only for AWS virtual-hosted style.                                                          |
| `ROLE`                 | `all`                       | `all` runs web and worker in one container. `web` and `worker` split them; see `docker-compose.split.yml`.                                  |
| `POSTGRES_USER`        | `spaces`                    | Read by the compose file for both containers.                                                                                               |
| `POSTGRES_PASSWORD`    | `spaces`                    | Read by the compose file. Set it before the first boot.                                                                                     |
| `POSTGRES_DB`          | `spaces`                    | Read by the compose file.                                                                                                                   |

With `STORAGE_DRIVER=s3`, `./data` still holds `secret.key`, so it still needs backing up. The bucket's own backup is yours to arrange.

## Local models with Ollama

The compose file carries an optional Ollama service under a profile, so the default stays at two containers:

```sh
docker compose --profile ollama up -d
docker compose exec ollama ollama pull nomic-embed-text
```

Then, in Spaces, open **Settings → AI · Providers** and save Ollama with the base URL `http://ollama:11434`. Pull whichever chat model you want to use the same way. Models live in their own `ollama_models` volume, outside `./data`, so they are not in your backups and do not need to be.

# Install

Spaces runs as two containers from one compose file: the app image and a
Postgres with pgvector. Nothing is built on your box. The image is pulled from
a published, pinned tag.

Every command on this page was run, in this order, on a machine holding only
the files the page tells you to download. The one exception is marked.

## What you need

- Docker Engine with Compose v2 (`docker compose`, not `docker-compose`).
- A Linux box or VM, `amd64` or `arm64`. One box is the intended shape.
- A domain name, if you want HTTPS. Optional until step 4.

## 1. Bring it up

```bash
mkdir spaces && cd spaces
curl -fsSLO https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.yml
docker compose up -d
```

The compose file pins one exact tag:

```yaml
image: ghcr.io/anishxbadri/spaces:0.1.0
```

That pin is deliberate. There is no `latest` tag to drift onto. Upgrading is
changing the tag on purpose, after a backup. See [upgrade.md](upgrade.md).

The same bytes are on Docker Hub as `docker.io/anishbadri/spaces:0.1.0`; both
registries carry a cosign signature and GHCR carries SLSA provenance
(`CONTEXT.md`, _Hosting_, has the `cosign verify` invocation).

First boot pulls both images and runs every migration before anything
serves traffic. Wait for the health endpoint to say the worker is up:

```bash
curl -fsS http://localhost:3000/api/health
```

```json
{
  "status": "ok",
  "db": "ok",
  "worker": { "status": "ok", "lastBeatSeconds": 3 }
}
```

Until the worker has beaten once the payload says `"worker": { "status": "absent" }`.
That takes a few seconds and is not an error.

## 2. Configuration: two variables, both already set

Only two environment variables are required, and the compose file sets
both:

| variable       | required | set by the compose file to                                   |
| -------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL` | yes      | the `db` service, from `POSTGRES_USER` / `POSTGRES_PASSWORD` |
| `APP_URL`      | yes      | `http://localhost:3000` unless you override it               |

There are no others you must set. That set is frozen: every later feature
ships with a working default or is optional.

`APP_URL` is the scheme and host **the browser sees**. It decides whether the
session cookie is marked `Secure`, and it is the origin of every link and
download URL the app produces. Leave it at the default only while you reach
the box as `http://localhost:3000`. As soon as a domain is in front of it,
set it, in a `.env` file beside the compose file:

```
APP_URL=https://deals.example.com
POSTGRES_PASSWORD=choose-one
```

Compose reads `.env` on its own. `POSTGRES_PASSWORD` defaults to `spaces`; set
it before the first boot, because the database is initialised with whatever
it was the first time.

Everything else is optional and has a default:

| variable             | default                     | what it does                                                                                                                                                 |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY`         | generated on first boot     | the key every stored credential is encrypted with; see _What lives in ./data_                                                                                |
| `STORAGE_DRIVER`     | `local`                     | `s3` puts blobs in a bucket instead of `./data` (`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`) |
| `BETTER_AUTH_SECRET` | derived from the master key | set it only if you want the session-signing secret rotated separately                                                                                        |
| `ROLE`               | `all`                       | `web` or `worker` for the split-role overlay, below                                                                                                          |

AI providers, enrichment keys and everything a user can configure are set
in the app under Settings, never in the environment.

## 3. What lives in `./data`

The compose file bind-mounts `./data` beside it. After the first boot it
holds:

```
data/
  secret.key     the master key, generated on first boot, 0600, owned by 1000
  setup-token    the first-run token; deleted the moment the first admin exists
  blobs/         every uploaded file, content-addressed, once one is uploaded
```

The database is in the `spaces_pgdata` Docker volume. Those two, together, are
your data. Nothing else on the box is.

**Lose `./data/secret.key` and every stored credential is unrecoverable.**
It is the key the vault encrypts every AI and provider key with, and there is
no second copy anywhere. Back it up with the database (step 5), and never
regenerate it.

### Ownership

You do not need to `chown` anything. The container starts as root, looks at
who owns `/data`, repairs it to the app user, and only then drops privileges.
On a fresh box the first boot logs exactly this:

```
[entrypoint] /data owned by 0:0 — repairing to 1000:1000
[entrypoint] /data ownership repaired
```

and every boot after it:

```
[entrypoint] /data ownership already 1000:1000 — no repair needed
```

The one case that still needs a hand is a container pinned to a non-root
user, which skips the repair because it cannot do it. If you add
`user: "1000:1000"` to the `app` service (or run rootless), a `./data` the
container cannot write refuses to boot rather than failing at the first
upload:

```
[entrypoint] /data is not writable by uid 1000:1000.
[entrypoint] Blobs and secret.key would fail at first upload, so this is a boot failure.
[entrypoint] Fix it on the host, then start again:  chown -R 1000:1000 ./data
```

Do what it says and start again:

```bash
sudo chown -R 1000:1000 ./data
docker compose up -d
```

## 4. First run: the setup token

Between `docker compose up` and the creation of the first admin, `/setup` is
reachable by anyone who can reach port 3000. So the wizard demands a one-time
token that is printed only to the container's log:

```bash
docker compose logs app | grep "setup token"
```

```
app-1  | [setup] First-run setup token: 7a3418ce3e8ead7759246e1d0be4664f
```

Open `http://localhost:3000/setup` (or your `APP_URL`), paste the token,
name the workspace and create the admin account. The token is consumed by
that submission and the file behind it is deleted; sign-up is closed from
then on, and the only way in for a second person is an invitation from
Settings. Login lands on `/today`.

If you exposed the port before reading this, the token is what stands
between the internet and your first admin account. Step 4 also closes the
port.

## 5. HTTPS: the TLS overlay

The app never terminates TLS. A reverse proxy is always in front, and
`APP_URL` is the single source of truth for scheme, cookies and every
external link. Caddy is the worked example, shipped as an overlay that needs
two more files beside the compose file:

```bash
curl -fsSLO https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.tls.yml
curl -fsSL --create-dirs -o docker/Caddyfile https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker/Caddyfile
```

Point an A or AAAA record at the box and open ports 80 and 443. Port 80 is
not optional: it carries the ACME challenge and the redirect to https. Then
put the domain in `.env`:

```
SPACES_DOMAIN=deals.example.com
APP_URL=https://deals.example.com
```

and start the stack with both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

_This is the one command on this page that was not run against a public
domain; it was run with `SPACES_DOMAIN=localhost` and `APP_URL=https://localhost`,
which takes the same path with Caddy's internal CA and is also how you
smoke-test the overlay on a box with no DNS._

Caddy obtains and renews the certificate on its own. Every boot logs the
decision the app made from `APP_URL`, before it serves anything:

```
[boot] external origin https://deals.example.com · cookies secure: yes · presign origin https://deals.example.com
```

The overlay also stops publishing port 3000 on the host: `curl
http://<host>:3000` is refused because nothing listens there, and a plain
`http://` request on 80 answers `308` to the `https://` URL. That closes the
first-run window from step 4 for good.

From here on, every `docker compose` command on this page and in
[upgrade.md](upgrade.md) takes the same two `-f` flags.

### The trap: an `http://` APP_URL behind an `https://` proxy

This failure is silent. With `APP_URL=http://deals.example.com` while Caddy
serves the same host over https, the login form posts, the server answers
200 and sets a cookie **without** `Secure`, the browser on an https page
drops it, and you land back on the login page with no error anywhere. Set
`APP_URL` to what the browser sees, never to the scheme of the hop into the
box. Boot warns when it looks wrong:

```
[boot] WARNING: APP_URL is http:// on a non-local host (deals.example.com). Session cookies will not be Secure. If a reverse proxy serves this app over https, set APP_URL=https://deals.example.com — the app trusts APP_URL, not the request, so an http APP_URL behind an https proxy means the browser never keeps the login cookie.
```

It is a warning, not a refusal: a plain-http install on a LAN is legitimate
and keeps working.

### nginx, Traefik, anything else

Nothing here is Caddy-specific. Another proxy needs exactly two things: a
correct `APP_URL`, and a proxy that speaks plain HTTP to the app container on
port 3000. The app reads no forwarded headers at all (a test pins that no
source file does), so a spoofed `X-Forwarded-Proto` cannot change a link, a
cookie or a redirect. Keep the host port unpublished, as the overlay does.

## 6. Back up

A backup is both halves or neither. Blobs are content-addressed files with no
names of their own, and the rows that name them are in Postgres; either half
alone is worthless. So one script produces one directory holding both, and
deletes the directory if either half fails.

```bash
curl -fsSL --create-dirs -o scripts/backup.sh https://raw.githubusercontent.com/AnishxBadri/Spaces/main/scripts/backup.sh
curl -fsSL -o scripts/restore.sh https://raw.githubusercontent.com/AnishxBadri/Spaces/main/scripts/restore.sh
chmod +x scripts/backup.sh scripts/restore.sh
sudo ./scripts/backup.sh
```

```
[backup] ok: ./backups/20260929-204042 (dump 148241 bytes, blobs 213 bytes, 0s)
[backup] restore it with: ./scripts/restore.sh ./backups/20260929-204042
```

`sudo` because the blob tree is `0600`, owned by uid 1000, and the script
has to read it to tar it. On an empty workspace the dump is about 150 KB and
the whole thing takes under a second; the size grows with your blobs.

Under the TLS overlay, name both files: `sudo ./scripts/backup.sh --file
docker-compose.yml --file docker-compose.tls.yml`.

One cron line is the whole backup policy:

```
0 3 * * *  cd /path/to/spaces && ./scripts/backup.sh
```

Copy `backups/` somewhere off the box. The directory contains `dump.sql` and
`blobs.tgz`, and `blobs.tgz` carries `secret.key`.
**Lose `./data/secret.key` and every stored credential is unrecoverable.**
A dump restored without it brings back rows that name blobs nobody can read
and credentials nobody can decrypt.

Restoring, and rolling back an upgrade, is [upgrade.md](upgrade.md#rollback).

## Split roles (optional)

The shipped compose runs web and worker as two processes in one container,
which is right for one box. To run them apart, overlay the split file:

```bash
curl -fsSLO https://raw.githubusercontent.com/AnishxBadri/Spaces/main/docker-compose.split.yml
docker compose -f docker-compose.yml -f docker-compose.split.yml up -d
```

`app` becomes `ROLE=web` and a `worker` service joins it on the same
`./data` and the same `DATABASE_URL`; the two talk only through Postgres.
`docker compose ps` shows both `healthy`. The worker container runs no HTTP
server, so its healthcheck reads its own heartbeat row instead: stop the
worker process and that container goes `unhealthy` within a minute while the
web container stays `healthy`.

## Checking that the worker is running

A crashed worker is the failure that looks healthy: the web container still
serves, and extraction silently never runs. So the worker writes a heartbeat
row every 15 seconds and `/api/health` reports it:

```json
{
  "status": "ok",
  "db": "ok",
  "worker": { "status": "ok", "lastBeatSeconds": 7 }
}
```

`worker.status` is `ok`, `stale` (no beat for 60 seconds) or `absent` (no row
yet). A stale or absent worker does not change the HTTP code: the web
container must never be restarted because the worker died. Only an
unreachable database answers `503` with `"status": "degraded"`. In the
single-container default, either process dying stops the container and
`restart: unless-stopped` brings it back.

## Not covered here

One-click templates for Coolify, Railway, Render and Unraid are a separate
piece of work and are not on this page. Nor is a comparison with hosted
tools, or a marketing site; this repository's `docs/` is the only source.

# One-click templates

The same two-container shape as `docker-compose.yml`, written the way four
platforms ask for it. Every template pins `ghcr.io/anishxbadri/spaces:0.1.0`
and never `latest`; upgrading is changing that tag after a backup
([docs/upgrade.md](../docs/upgrade.md)).

| platform | file                                                     | tested by a human       | database                                              | `APP_URL`                                               |
| -------- | -------------------------------------------------------- | ----------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Coolify  | [coolify/spaces.yaml](coolify/spaces.yaml)               | **untested** 2026-09-29 | `pgvector/pgvector:pg17`, provisioned by the template | `SERVICE_URL_APP_3000`, the URL Coolify assigns         |
| Railway  | [railway/template.json](railway/template.json)           | **untested** 2026-09-29 | `pgvector/pgvector:pg17`, provisioned by the template | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                    |
| Render   | [render/render.yaml](render/render.yaml)                 | **untested** 2026-09-29 | Render Postgres 17 (pgvector from its extension list) | asked for when the Blueprint is applied (`sync: false`) |
| Unraid   | [unraid/spaces.xml](unraid/spaces.xml) + `-postgres.xml` | **untested** 2026-09-29 | `pgvector/pgvector:pg17`, a second template           | typed in: Unraid assigns no domain                      |

A template is marked tested only after someone has deployed it, read the
setup token out of that platform's log view, reached `/setup` and finished
the wizard. The checklist for that is at the end of this page.

## What every template guarantees

- **pgvector 0.8 or newer.** The migrations create the `vector` extension and
  the search lane sets an option older pgvector refuses. Three templates
  provision `pgvector/pgvector:pg17` (pgvector 0.8.x, the image compose uses)
  themselves. Render's managed Postgres 17 carries pgvector in its extension
  list; if `select extversion from pg_extension where extname = 'vector'`
  reports less than 0.8 on the day you deploy, that platform is unsupported
  until Render updates it. No template provisions a plain Postgres.
- **`APP_URL` is the platform's assigned domain** wherever the platform can
  say what it is (Coolify, Railway). Render's Blueprint spec has no reference
  to a service's own public URL, so its template prompts for the value;
  Unraid assigns no domain at all, so its template asks for the address you
  open. All four platforms except a LAN Unraid terminate TLS, and the session
  cookie is `Secure` only when `APP_URL` says `https://` — an `http://` value
  behind an `https://` proxy is the silent login loop
  [install.md](../docs/install.md#the-trap-an-http-app_url-behind-an-https-proxy)
  describes.
- **`/data` is a persistent volume** (Render disk, Railway volume, Coolify
  named volume, Unraid appdata path), because it holds the blobs and the
  auto-generated `secret.key`.
  **Lose `./data/secret.key` and every stored credential is unrecoverable.**
  Each template's description says the same sentence.
- **Two required variables, nothing else.** `DATABASE_URL` and `APP_URL`, as
  everywhere. `MASTER_KEY` is generated on first start unless you set it.
- **Ollama is not provisioned.** Local embeddings are opt-in and need a host
  of their own; add one and point Settings → AI · Providers at it.
- **The setup token is in the platform's log view.** Every first boot prints
  `[setup] First-run setup token: <32 hex characters>`; the wizard at
  `/setup` demands it, then the file behind it is deleted.

## Coolify

`coolify/spaces.yaml` is a Coolify compose service. New Resource → Docker
Compose Empty → paste the file → set the domain on the `app` service → Deploy.
Coolify fills `SERVICE_URL_APP_3000` (the app's URL, scheme included) and
`SERVICE_PASSWORD_POSTGRES` (the database password) and keeps both across
deploys. The header comments are the format Coolify's own service catalogue
uses, so the file can also be submitted there.

## Railway

Railway templates are composed in the dashboard and have no file format;
`railway/template.json` is the composer's answers, field by field, so the
template can be built and published without deciding anything. Two services
from images (`spaces`, `Postgres`), a volume on each, the app's variables
referencing the database over the private network and its own
`RAILWAY_PUBLIC_DOMAIN`. Railway's stock Postgres has no pgvector; the
template uses `pgvector/pgvector:pg17` instead. `railway/railway.json` is
config-as-code for a service deployed from this repository rather than the
image; it carries the same health check and restart policy.

## Render

`render/render.yaml` is a Blueprint: one web service from the image, one
Render Postgres 17, one 5 GB disk at `/data`. New → Blueprint → this
repository (or paste the file). Render asks for `APP_URL` while applying it;
after the first deploy, paste the `https://….onrender.com` URL it assigned
(or your custom domain) and let it redeploy. The database's `ipAllowList` is
empty, so it is reachable only over Render's private network.

## Unraid

Two Community Applications templates, because Unraid has no compose:
`unraid/spaces-postgres.xml` first (choose a password), then
`unraid/spaces.xml` with `DATABASE_URL` pointing at it and `APP_URL` set to
the address you will open, `http://<unraid-ip>:3000` on a LAN. Docker → Add
Container → Template repositories, or paste each file's raw URL. The
container repairs the appdata path's ownership itself on every start.

## Owner checklist, per platform

A platform's row above changes from **untested** to the date it was run once
every box below is ticked for it. Screenshots go on the PR.

- [ ] **Coolify** — paste `coolify/spaces.yaml`, set the domain, Deploy. Open
      the `app` container's Logs, copy the `First-run setup token`. Open
      `https://<domain>/setup`, paste it, create the admin, land on `/today`.
      In the browser's devtools, the session cookie shows `Secure`. Screenshot
      `/today` and the cookie.
- [ ] **Railway** — build the template from `railway/template.json` in the
      composer, deploy it. Open the `spaces` service's Deploy Logs, copy the
      token. Open the assigned domain at `/setup`, finish the wizard, confirm
      the `Secure` cookie. Screenshot. Publish the template and put its
      `railway.com/template/…` link in this README.
- [ ] **Render** — apply `render/render.yaml`, enter a placeholder for
      `APP_URL`, then set it to the assigned `https://….onrender.com` URL and
      redeploy. Confirm `select extversion from pg_extension where extname =
'vector'` on the database is 0.8 or newer. Logs tab → copy the token →
      `/setup` → wizard → `Secure` cookie. Screenshot.
- [ ] **Unraid** — install `spaces-postgres.xml`, then `spaces.xml` with the
      password and the Unraid IP filled in. Docker → spaces → Logs → copy the
      token → WebUI `/setup` → wizard. Screenshot. (On a LAN over `http://`
      the cookie is not `Secure`, by design; behind a reverse proxy with
      `APP_URL=https://…` it is.)

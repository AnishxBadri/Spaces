# Spaces

Self-hosted deal management for angel and private-capital investing.

## Getting started (from a clean clone)

```bash
pnpm install                                      # links apps/web and packages/config
docker compose -f docker-compose.dev.yml up -d    # Postgres :5432 (+ MinIO :9000)
$EDITOR .env.local                                # the two values below
pnpm db:migrate:run                               # migrations + system attributes
pnpm dev                                          # http://localhost:3000
pnpm worker                                       # in a second terminal
```

`.env.local` lives at the **repo root** and needs two values:

```
DATABASE_URL=postgresql://spaces:spaces@localhost:5432/spaces
BETTER_AUTH_SECRET=<pnpm dlx @better-auth/cli secret>
```

## Repo layout

This is a pnpm workspace (since 2026-09-19).

```
apps/web/            the app — @spaces/web. src/, drizzle/, and the configs it owns
packages/config/     tsconfig.base.json, shared by every package
eslint.config.js     one lint vocabulary for the workspace (+ eslint-rules/)
scripts/             backup.sh, restore.sh — operator scripts
docker/              entrypoint.sh, Caddyfile
```

Every script below runs **from the repo root**; each is a proxy that delegates
with `pnpm --filter`. Inside a package, `#/` always means that package's own
`src/`, so `#/lib/server/deals` in `apps/web` is `apps/web/src/lib/server/deals`.

| command               | what it does                                 |
| --------------------- | -------------------------------------------- |
| `pnpm dev`            | vite dev server on :3000                     |
| `pnpm worker`         | the pg-boss worker                           |
| `pnpm build`          | production build into `apps/web/.output`     |
| `pnpm test`           | vitest (needs Postgres up)                   |
| `pnpm typecheck`      | both tsconfigs — the root one and apps/web's |
| `pnpm lint`           | eslint, including the design-token rule      |
| `pnpm db:migrate:run` | run migrations and reseed system attributes  |
| `pnpm db:generate`    | generate a migration after a schema change   |

# Self-hosting over HTTPS

The app never terminates TLS. A reverse proxy is always in front, and
`APP_URL` is the single source of truth for scheme, cookies and every
external link. Caddy is the worked example, shipped as an overlay:

```bash
SPACES_DOMAIN=deals.example.com \
APP_URL=https://deals.example.com \
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Point an A/AAAA record at the box and open 80 and 443 first — 80 is not
optional, it carries the ACME challenge and the redirect to https. Caddy
issues and renews the certificate on its own; `docker/Caddyfile` is one
block, plus a commented variant for operators whose TLS is already
terminated further upstream.

The overlay also stops publishing 3000 on the host. `curl http://<host>:3000`
from outside is refused because nothing listens there, which incidentally
closes the first-run window: between `compose up` and the creation of the
first admin, `/setup` is reachable by anyone who can reach the port.

Every boot logs the decision it made, before anything serves traffic:

```
[boot] external origin https://deals.example.com · cookies secure: yes · presign origin https://deals.example.com
```

## Trap 1 — an http APP_URL behind an https proxy

This is the failure the contract exists to prevent, and it is silent.
Reproduce it by leaving `APP_URL=http://deals.example.com` while Caddy serves
the same host over https: the login form posts, the server answers 200 and
sets a session cookie **without** the `Secure` flag, the browser on an https
page drops it, and the next request is unauthenticated — so you land back on
the login page with no error anywhere. Nothing is broken; the cookie simply
never arrived.

Set `APP_URL` to the scheme and host the **browser** sees, never the scheme
of the hop into the box. Boot warns loudly when `APP_URL` is `http://` and
the host is not localhost:

```
[boot] WARNING: APP_URL is http:// on a non-local host (deals.example.com). Session cookies will not be Secure. …
```

It is a warning, not a refusal — a plain-http install on a LAN is a
legitimate configuration and keeps working.

## nginx, Traefik, anything else

Nothing here is Caddy-specific. An operator on another proxy needs exactly
two things: a correct `APP_URL`, and a proxy that sets `X-Forwarded-Proto`
for anything else downstream that cares. The app itself reads no forwarded
headers at all — a test pins that no source file does — so a spoofed header
cannot change a link, a cookie or a redirect. Proxy to the app container on
port 3000 over plain HTTP and keep the host port unpublished.

Blob downloads follow the same rule: presigned URLs for the local storage
driver are built from `APP_URL`, not from the incoming request, so they come
out `https://` and download back through the proxy.

# Building For Production

To build this application for production:

```bash
pnpm build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `apps/web/src/routes/demo/`
2. Replace the Tailwind import in `apps/web/src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `apps/web/vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `apps/web/package.json`

## Linting & Formatting

This project uses [eslint](https://eslint.org/) and [prettier](https://prettier.io/) for linting and formatting. Eslint is configured using [tanstack/eslint-config](https://tanstack.com/config/latest/docs/eslint). The following scripts are available:

```bash
pnpm lint
pnpm format
pnpm check
```

## Setting up Better Auth

1. Generate and set the `BETTER_AUTH_SECRET` environment variable in your `.env.local`:

   ```bash
   pnpm dlx @better-auth/cli secret
   ```

2. Visit the [Better Auth documentation](https://www.better-auth.com) to unlock the full potential of authentication in your app.

### Adding a Database (Optional)

Better Auth can work in stateless mode, but to persist user data, add a database:

```typescript
// apps/web/src/lib/auth.ts
import { betterAuth } from 'better-auth'
import { Pool } from 'pg'

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  // ... rest of config
})
```

Then run migrations:

```bash
pnpm dlx @better-auth/cli migrate
```

## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).
Run it inside `apps/web`, which is where `components.json` lives.

```bash
cd apps/web && pnpm dlx shadcn@latest add button
```

## T3Env

- You can use T3Env to add type safety to your environment variables.
- Add Environment variables to the `apps/web/src/env.mjs` file.
- Use the environment variables in your code.

### Usage

```ts
import { env } from '#/env'

console.log(env.VITE_APP_TITLE)
```

## Deploy with Nitro

This project uses Nitro as a generic server adapter, so it can run on any Node-compatible host.

```bash
npm run build
node dist/server/index.mjs
```

The build output is a self-contained Node server. To deploy, push the `dist/` directory to your host (Render, Fly.io, your own VPS, etc.) and run the server command above.

For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda, etc.) and tuning, see https://v3.nitro.build/deploy.

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `apps/web/src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./apps/web/src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from '@tanstack/react-router'
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `apps/web/src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')

  useEffect(() => {
    getServerTime().then(setTime)
  }, [])

  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).

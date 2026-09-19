import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Anchored to this file, not to cwd: `.env.local` stays at the workspace root
// while drizzle-kit runs with cwd = packages/db. Getting this wrong is silent
// — DATABASE_URL is simply undefined and drizzle-kit reports a connection it
// never had. `packages/db` sits the same two levels down that `apps/web` did,
// so the `../../` survived the move (SPA-142) — but it survived by being
// checked, not by being lucky: `pnpm db:generate --name probe` from the repo
// root has to report no pending change, and a config that never reached the
// database would report exactly the same thing if the schema path were also
// wrong.
config({
  path: ['.env.local', '.env'].map((name) =>
    fileURLToPath(new URL(`../../${name}`, import.meta.url)),
  ),
})

export default defineConfig({
  out: './drizzle',
  schema: './src/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})

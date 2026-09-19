import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Anchored to this file, not to cwd: `.env.local` stays at the workspace root
// while drizzle-kit now runs with cwd = apps/web. Getting this wrong is silent
// — DATABASE_URL is simply undefined and drizzle-kit reports a connection it
// never had.
config({
  path: ['.env.local', '.env'].map((name) =>
    fileURLToPath(new URL(`../../${name}`, import.meta.url)),
  ),
})

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})

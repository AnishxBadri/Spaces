/**
 * Keys the Apollo plugin from `APOLLO_API_KEY`: the key becomes the
 * workspace `enrichment` credential (encrypted by the vault) and the `apollo`
 * integration row points at it, enabled. Safe to re-run with a new key.
 *
 *   APOLLO_API_KEY=… pnpm exec tsx scripts/apollo-key.ts
 *
 * Reads `.env.local` at the repo root for DATABASE_URL and MASTER_KEY; a
 * variable already set in the environment wins. A stand-in for the plugin
 * settings form.
 */
import { existsSync, readFileSync } from 'node:fs'

function fail(message: string): never {
  console.error(`apollo-key: ${message}`)
  process.exit(1)
}

const secret = process.env.APOLLO_API_KEY?.trim() ?? ''
if (secret === '') fail('APOLLO_API_KEY is not set')

const envFile = new URL('../.env.local', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set')

const pkg: unknown = JSON.parse(
  readFileSync(
    new URL('../plugins/apollo/package.json', import.meta.url),
    'utf8',
  ),
)
const version =
  typeof pkg === 'object' &&
  pkg !== null &&
  'version' in pkg &&
  typeof pkg.version === 'string'
    ? pkg.version
    : fail('plugins/apollo/package.json has no version')

// Imported only now: @spaces/db opens its pool on DATABASE_URL at import.
const { db } = await import('@spaces/db')
const { Effect } = await import('effect')
const { keyIntegration } = await import('@spaces/core/writes/plugins/key')

const admin = await db.query.user.findFirst({
  where: (u, { eq }) => eq(u.role, 'admin'),
  orderBy: (u, { asc }) => [asc(u.createdAt)],
})
if (!admin) fail('no admin user yet — finish first-run setup, then re-run')

const result = await Effect.runPromise(
  keyIntegration({
    capabilityId: 'apollo',
    version,
    kind: 'enrichment',
    secret,
    createdBy: admin.id,
  }),
).catch((error: unknown) =>
  fail(error instanceof Error ? error.message : String(error)),
)

console.info(
  `apollo-key: ${result.created ? 'created' : 'updated'} integration ${result.integrationId} (enabled), credential ${result.credentialId} = ${result.display}`,
)
await db.$client.end()

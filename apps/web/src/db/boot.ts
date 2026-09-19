import { runMigrations } from '@spaces/db/migrate'
import { logExternalOrigin } from '#/lib/server/external-origin'

/**
 * The boot entry — called by the container entrypoint on every boot
 * (migrations auto-run, no `docker exec` step) and usable in dev as
 * `pnpm db:migrate:run`.
 *
 * It is the composition, and only the composition: migrate, then system
 * attributes, then the starter taxonomy, in that order, as one command. The
 * migration half belongs to `@spaces/db` and knows nothing about seeds; the
 * two seeds belong to core-to-be and live in apps/web today. That is the
 * interim shape recorded in CONTEXT.md ("packages/db — what moved and what
 * did not") — mono-9a moves the seeds into core and this file with them,
 * and the one-command contract survives both moves.
 */
async function main() {
  // The entrypoint runs this before either process starts, for every ROLE,
  // so it is the one place that logs exactly once per boot. Print the
  // APP_URL decision first: when HTTPS is misconfigured, the answer is
  // waiting at the top of `docker compose logs app`. `logExternalOrigin`
  // only prints — it reads APP_URL and touches no database — so keeping it
  // ahead of the downgrade guard costs nothing, and a refused boot still
  // tells the operator which origin this image thought it had.
  logExternalOrigin()

  // argv[2], when present, names the migrations folder. Nothing in the boot
  // path passes it — `@spaces/db` resolves its own journal from
  // `import.meta.url`, so this runs identically from any cwd. It is how
  // `boot.test.ts` boots this entry against deliberately truncated journals,
  // and it defeats nothing: the guard runs against whatever folder is named.
  const folder = process.argv.at(2)
  const outcome = await runMigrations(
    folder === undefined ? undefined : { migrationsFolder: folder },
  )
  if (outcome.kind === 'refused') process.exit(1)

  // System attributes: insert-if-absent on every boot; user edits survive.
  const { seedSystemAttributes } = await import('#/lib/attributes/seed')
  await seedSystemAttributes()
  // Starter taxonomy: first boot only, so deleted nodes stay deleted.
  const { seedStarterTaxonomy } = await import('#/lib/seeds/taxonomy')
  await seedStarterTaxonomy()
  process.exit(0)
}

main().catch((err) => {
  console.error('[migrate] failed', err)
  process.exit(1)
})

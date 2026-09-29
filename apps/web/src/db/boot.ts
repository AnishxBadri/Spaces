import { boot } from '@spaces/core/writes/boot'
import { dataDir } from '@spaces/core/writes/vault/key'
import { logExternalOrigin } from '#/lib/server/external-origin'

/**
 * The boot entry — called by the container entrypoint on every boot
 * (migrations auto-run, no `docker exec` step) and usable in dev as
 * `pnpm db:migrate:run`.
 *
 * The composition — migrate, then system attributes, then the starter
 * taxonomy, then the value-index reconcile, as one command — is
 * `@spaces/core`'s `boot()` since SPA-177. What is left here is the process:
 * the two lines an operator reads at the top of `docker compose logs app`,
 * the argv a test hands over, and the exit code.
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
  // Where secret.key, the setup token and the blobs live, said once per boot
  // (SPA-176): an unset DATA_DIR resolves to `<workspace root>/data`, and
  // the failure this line exists to make visible is the quiet one — a wrong
  // directory means a freshly generated key and every stored credential
  // unreadable, with nothing thrown.
  console.log(`[data] DATA_DIR resolved to ${dataDir()}`)

  // argv[2], when present, names the migrations folder. Nothing in the boot
  // path passes it — `@spaces/db` resolves its own journal from
  // `import.meta.url`, so this runs identically from any cwd. It is how
  // `boot.test.ts` boots this entry against deliberately truncated journals.
  const folder = process.argv.at(2)
  const outcome = await boot(
    folder === undefined ? undefined : { migrationsFolder: folder },
  )
  process.exit(outcome.kind === 'refused' ? 1 : 0)
}

main().catch((err) => {
  console.error('[migrate] failed', err)
  process.exit(1)
})

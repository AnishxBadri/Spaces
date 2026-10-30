import { boot } from '@spaces/core/writes/boot'
import { dataDir } from '@spaces/core/writes/vault/key'
import { logExternalOrigin } from '#/lib/server/external-origin'

/**
 * The boot entry — called by the container entrypoint on every boot
 * (migrations auto-run, no `docker exec` step) and usable in dev as
 * `pnpm db:migrate:run`.
 *
 * The composition (migrate, system attributes, starter taxonomy, value-index
 * reconcile, the bundled plugins and the optional `SPACES_PLUGINS` install) is
 * `@spaces/core`'s `boot()`.
 * This is the process around it: the two log lines an operator reads first,
 * the argv a test hands over, and the exit code.
 */
async function main() {
  // The one place that logs exactly once per boot, for every ROLE. The APP_URL
  // decision prints first so a misconfigured HTTPS shows at the top of the
  // logs; `logExternalOrigin` touches no database, so it runs ahead of the
  // downgrade guard and a refused boot still names its origin.
  logExternalOrigin()
  // Where secret.key, the setup token and the blobs live, said once per boot:
  // a wrong directory means a freshly generated key and every stored credential
  // unreadable, with nothing thrown.
  console.log(`[data] DATA_DIR resolved to ${dataDir()}`)

  // argv[2], when present, names the migrations folder: how the boot test runs
  // against truncated journals. Otherwise `@spaces/db` resolves its own journal
  // from `import.meta.url`, so this runs identically from any cwd.
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

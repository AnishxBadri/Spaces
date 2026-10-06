/**
 * `changeset version` for this repo: core (the root package `spaces`) is a
 * version line like any plugin, which the stock command cannot see.
 *
 *   pnpm release:status    the plan the pending changesets make; writes nothing
 *   pnpm release:version   apply it: bump, delete the changesets, sync the
 *                          manifest / SDK_VERSION lines
 *
 * The release workflow's changesets action runs `release:version` to open
 * the release PR.
 */
import { readChangesets } from '@changesets/read'
import {
  ROOT,
  loadConfig,
  releasePlanFor,
  versionPackages,
  workspacePackages,
} from './release/versioning.ts'

const statusOnly = process.argv.includes('--status')

const plan = statusOnly
  ? await (async () => {
      const packages = await workspacePackages(ROOT)
      return releasePlanFor(
        await readChangesets(ROOT),
        packages,
        await loadConfig(packages),
      )
    })()
  : await versionPackages(ROOT)

if (plan.releases.length === 0) {
  console.info('no pending changesets')
} else {
  for (const r of plan.releases) {
    console.info(`${r.name}: ${r.oldVersion} → ${r.newVersion} (${r.type})`)
  }
  if (!statusOnly) console.info('bumped; review and commit')
}

/**
 * Tags what a merged release PR bumped: `core@X.Y.Z` for the root package,
 * `plugin-<id>@X.Y.Z` per plugin, `sdk@X.Y.Z` for the contract. A package is
 * tagged when its version differs from the one at `--since` (default HEAD^,
 * the merge's parent) and the tag does not exist yet, so a re-run is a no-op.
 *
 *   pnpm exec tsx scripts/release-tags.ts [--since <ref>] [--push]
 *
 * `--push` pushes each tag on its own: GitHub starts no workflow for a push
 * of more than three tags at once, and the image and plugin workflows each
 * fire on one.
 */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import {
  ROOT,
  loadConfig,
  parsePackageJson,
  tagCandidates,
  tagsToCreate,
  workspacePackages,
} from './release/versioning.ts'

const { values } = parseArgs({
  options: {
    since: { type: 'string', default: 'HEAD^' },
    push: { type: 'boolean', default: false },
  },
})

const git = (...args: Array<string>): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const succeeds = (...args: Array<string>): boolean => {
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const packages = await workspacePackages(ROOT)
const candidates = tagCandidates(packages, await loadConfig(packages))
const since = values.since
const created = tagsToCreate(candidates, {
  tagExists: (tag) =>
    succeeds('rev-parse', '-q', '--verify', `refs/tags/${tag}`),
  versionAtBase: (relativeDir) => {
    const file =
      relativeDir === '' ? 'package.json' : `${relativeDir}/package.json`
    if (!succeeds('cat-file', '-e', `${since}:${file}`)) return null
    return parsePackageJson(git('show', `${since}:${file}`)).version
  },
})

if (created.length === 0) console.info(`nothing bumped since ${since}`)
for (const c of created) {
  git('tag', c.tag)
  console.info(`New tag: ${c.tag}`)
}
if (values.push) {
  for (const c of created) git('push', 'origin', `refs/tags/${c.tag}`)
}

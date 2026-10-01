import { realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { HOST_PACKAGES } from '@spaces/sdk/build'

/**
 * A plugin bundle runs on the host's Effect (sdk-11). The plugin build
 * (`@spaces/sdk/build`) leaves exactly three bare imports in `bundle.mjs` —
 * `effect`, `zod`, `@spaces/sdk` — and a bundle lives in
 * `<dataDir>/plugins/<id>/current/`, where node's own lookup would walk up
 * from `/data` and find no `node_modules` at all (or, worse, some other
 * copy). Two copies of the SDK in one process means two sets of service
 * tags, and a job yielding the plugin's `Identity` against a Layer built from
 * the host's is "service not found".
 *
 * So a synchronous resolve hook (`module.registerHooks`, node ≥ 22.15 —
 * in-thread, no loader file to ship beside the bundle, which is why it is
 * this and not `module.register()`): a bare import of one of the three,
 * made by a module under a registered plugins root, is resolved as if this
 * file had made it. The host's resolver, the host's conditions, the host's
 * `node_modules` — the same URL, so the same module instance, as the
 * worker's own `import { Identity } from '@spaces/sdk'`. In the image this
 * file is inside `apps/worker/dist/index.mjs`, which is why `@spaces/sdk` is
 * external to the worker bundle and present in `/app/node_modules`.
 *
 * Every other specifier passes through untouched, so a bundle that imports
 * anything else (it cannot — the build inlines everything but the three and
 * `node:*`) fails to resolve, as it should.
 */

const HOST_URL = import.meta.url

const isHostPackage = (specifier: string): boolean =>
  HOST_PACKAGES.some(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  )

const realpath = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const roots = new Set<string>()
let registered = false

/** Route plugin bundles under `pluginsRoot` to the host's three packages. */
export function resolvePluginImportsToHost(pluginsRoot: string): void {
  // Node hands the hook a module's *real* path as `parentURL` (symlinks
  // resolved), so the root is compared as a real path too — macOS's
  // `/var/folders/…` tmpdir is a symlink into `/private/var`, and a root
  // spelled through it would never prefix the bundle's URL.
  const root = pathToFileURL(realpath(pluginsRoot)).href.replace(/\/?$/, '/')
  roots.add(root)
  if (registered) return
  registered = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL
      if (
        parent !== undefined &&
        isHostPackage(specifier) &&
        [...roots].some((r) => parent.startsWith(r))
      ) {
        return nextResolve(specifier, { ...context, parentURL: HOST_URL })
      }
      return nextResolve(specifier, context)
    },
  })
}

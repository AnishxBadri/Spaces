import { realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { HOST_PACKAGES } from '@spaces/sdk/build'

/**
 * A plugin bundle runs on the host's Effect, sdk and zod. The plugin build
 * leaves exactly three bare imports (`effect`, `zod`, `@spaces/sdk`), and
 * node's own lookup from `<dataDir>/plugins/<id>/current/` finds no
 * `node_modules` (or some other copy). Two SDK copies mean two sets of
 * service tags, and a job's `Identity` against the host's Layer is "service
 * not found".
 *
 * - A synchronous in-thread hook (`module.registerHooks`, node ≥ 22.15), so
 *   no loader file ships beside the bundle, unlike `module.register()`.
 * - A bare import of one of the three, from a module under a registered
 *   plugins root, resolves as if this module made it: the same URL, so the
 *   same instance as the worker's own. This is why the worker bundle leaves
 *   `@spaces/sdk` external and the image ships it in `node_modules`.
 * - Every other specifier passes through untouched; the build inlines
 *   everything else but `node:*`, so anything more fails to resolve, as it
 *   should.
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

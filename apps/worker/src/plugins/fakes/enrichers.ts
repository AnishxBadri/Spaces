import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue } from '@spaces/sdk'

/**
 * The enrichers the conformance and chaos suites run, each against its
 * provider fake: a second enricher is one more entry here. Test support —
 * nothing in the worker process imports it.
 *
 * Every entry names a company its cassette has a recorded match for (and
 * the values that fill), and one the provider has nothing on.
 */
export type Enricher = {
  /** The manifest id, and the directory under `plugins/`. */
  readonly id: string
  /** The action job that enriches a company by its domain. */
  readonly companyJob: string
  readonly matched: {
    readonly name: string
    readonly domain: string
    readonly values: { readonly [slug: string]: JsonValue }
  }
  readonly unmatched: { readonly name: string; readonly domain: string }
  /** True for the provider request that asks about `domain`. */
  readonly asksAbout: (domain: string) => (url: string) => boolean
}

const byDomainParam =
  (domain: string) =>
  (url: string): boolean =>
    new URL(url).searchParams.get('domain') === domain

export const ENRICHERS: ReadonlyArray<Enricher> = [
  {
    id: 'apollo',
    companyJob: 'enrichCompany',
    matched: {
      name: 'Northwind Robotics',
      domain: 'northwind-robotics.example',
      values: {
        description:
          'Warehouse picking robots that learn a new SKU from one demonstration.',
        founded_year: 2019,
        location: 'Pune, India',
        linkedin: 'http://www.linkedin.com/company/northwind-robotics',
      },
    },
    unmatched: { name: 'Nobody Knows', domain: 'no-such-company.example' },
    asksAbout: byDomainParam,
  },
]

/** The repository's `plugins/`, where each enricher's built bundle is. */
export const REPO_PLUGINS = fileURLToPath(
  new URL('../../../../../plugins/', import.meta.url),
)

/**
 * A fresh `<tmp>/plugins` with each plugin's `dist/` installed at
 * `<id>/current`, as the installer leaves it (no lock.json: unpinned).
 * A name is a directory under `plugins/` (`apollo`, `_fixtures/needs-key`).
 */
export const pluginsRootWith = (
  label: string,
  names: ReadonlyArray<string>,
): string => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), `spaces-${label}-`)),
    'plugins',
  )
  for (const name of names) {
    const dir = path.join(root, path.basename(name), 'current')
    mkdirSync(dir, { recursive: true })
    for (const file of ['bundle.mjs', 'manifest.json'])
      cpSync(path.join(REPO_PLUGINS, name, 'dist', file), path.join(dir, file))
  }
  return root
}

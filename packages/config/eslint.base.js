//  @ts-check

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tanstackConfig } from '@tanstack/eslint-config'
import { createNodeResolver } from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
// @ts-expect-error eslint-plugin-drizzle 0.2.3 ships no declaration file; the day it does, this line fails and comes out.
import drizzle from 'eslint-plugin-drizzle'
import instrument from './eslint-rules/vocabulary.js'

// The repo root: two levels above this file, which lives in packages/config
// since SPA-180 and is reached through the root `eslint.config.js` shim. It is
// not itself named eslint.config.js because ESLint looks a config up from the
// cwd, and under `@spaces/config#lint` this directory is the cwd — the base
// would be found first and every root-relative glob below would re-base here.
// `import/no-restricted-paths` resolves its zones against `basePath`, and a
// relative '.' means eslint's cwd — which is the repo root under CI and the
// pre-commit hook but `apps/web` under turbo's `@spaces/web#lint` task, where
// the zones then matched nothing and the server-only seam went silent (found
// by SPA-135). Absolute, it is the same directory from every cwd.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// `Intl.NumberFormat`, banned everywhere but the two format modules, and
// `entity.values`, written only by setValues. Both are `no-restricted-syntax`,
// and a flat-config block does not merge a rule's options with an earlier
// block's — it replaces them. Declared once here and composed below so neither
// selector can shadow the other, which is what happened while both lived in
// their own block: only the last one was ever enforced (SPA-101).
const NO_INTL_NUMBER_FORMAT = {
  selector:
    "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
  message:
    'Use fmtMoney (packages/core/src/portfolio/format.ts) or the shared formatters in packages/core/src/format.ts — Intl.NumberFormat compact output differs between Node and Chrome (hydration trap).',
}
// Spec §2's forbidden edge: `web → core, sdk. Never plugins/*, never worker.`
// The web app used to take `QueueName` from `#/worker/queues`, which is the
// whole reason `apps/worker` could not be lifted out without web following it
// (SPA-146). Both halves of the seam live in @spaces/core now, so the edge can
// be a rule rather than a convention. Declared once and composed below because
// a later flat-config block replaces an earlier block's options for the same
// rule rather than merging with them — the trap that silenced one of these
// selectors for a whole cycle (SPA-101).
const NO_WEB_INTO_WORKER = {
  target: './apps/web/src',
  from: './apps/web/src/worker',
  message:
    'The web app never imports the worker (spec §2). Queue names and the sender live in @spaces/core/queue/*.',
}
const SERVER_ONLY = {
  target: './apps/web/src',
  from: './apps/web/src/lib/server',
  message:
    'Server helpers are server-only. Client code imports from the server-fns barrel (apps/web/src/lib/server-fns.ts).',
}
const NO_DIRECT_ENTITY_VALUES = {
  selector:
    "CallExpression[callee.property.name='set'][callee.object.callee.property.name='update'][callee.object.arguments.0.name='entity'] > ObjectExpression > Property[key.name='values']",
  message:
    'entity.values has one write path — go through setValues (packages/core/src/writes/attributes/values.ts) so validation, attribute_event, and reference links stay in one transaction.',
}

// The dependency rules of docs/spec-plugin-sdk.md §2 ("Rules the turbo graph
// and `no-restricted-imports` enforce"), one `no-restricted-imports` pattern
// per package (SPA-180). The turbo graph is the allow list — a package's
// package.json names what it may depend on — and these are the "never"
// clauses, spelled as the specifiers a violation would be written with: the
// internal package name (`@spaces/<name>`), the web app's `#/` alias, and a
// relative path that climbs out of the package into another. A specifier ban
// rather than a resolved-path zone on purpose: it fires on a package that is
// not installed (a plugin fixture with no `@spaces/db` in its node_modules
// resolves nothing, and `import/no-restricted-paths` would stay silent) and
// on a package that does not exist yet, and it catches `import type` too —
// the spec's edge is the dependency, not the bundle. (Verified while writing
// this: the resolver follows pnpm's symlinks to the real path, so a
// resolved-path zone would fire on `@spaces/core` from packages/db as well
// and report every such line twice.) The cost is in the climb pattern: a
// relative path is matched by the directory it lands in, and a sibling
// package is reached by its bare name (`../../core/` from packages/db/src),
// so each package bans its siblings' bare names as climb targets. That is
// unambiguous only while no package has a subdirectory named for a sibling
// package, which none does; the message says which rule was tripped.
//
// Each rule's `files` is the package directory. Two packages are not born:
// `packages/sdk` (sdk-3) and `plugins/*`. Their zones are written now, so the
// packages grow up inside the fence, and are fenced against
// `packages/config/fixtures/{sdk,plugins}` until then — that is where their
// failing case runs. The worker zone is the third: `apps/worker` lands in
// mono-11a (SPA-181), which is where it gets its failing-case test; until
// then its glob matches nothing and the zone is unproven.
/** @param {ReadonlyArray<string>} names */
const internal = (names) => `^@spaces/(${names.join('|')})(/|$)`
/** @param {ReadonlyArray<string>} dirs */
const climbsInto = (dirs) => `^(\\.\\./)+(${dirs.join('|')})/`
const PLUGIN_PKG = 'plugin-[^/]+'

const DB_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    internal(['core', 'sdk', 'web', 'worker', PLUGIN_PKG]),
    '^#/',
    climbsInto(['apps', 'plugins', 'packages/(core|sdk)', 'core', 'sdk']),
  ].join('|'),
  message:
    '@spaces/db imports nothing internal — the schema, the journal, ENTITY_REFS and the migrator depend on drizzle, pg and zod and on no package in this repo (docs/spec-plugin-sdk.md §2: "db → nothing internal").',
}
const CORE_IMPORTS_DB_AND_SDK_ONLY = {
  regex: [
    internal(['web', 'worker', PLUGIN_PKG]),
    '^#/',
    climbsInto(['apps', 'plugins', 'web', 'worker']),
  ].join('|'),
  message:
    '@spaces/core imports @spaces/db and @spaces/sdk, never the web app, the worker or a plugin (docs/spec-plugin-sdk.md §2: "core → db, sdk. Never web"). A helper core needs from apps/web moves into core; core never reaches back.',
}
const WEB_NEVER_PLUGINS_NEVER_WORKER = {
  regex: [
    internal(['worker', PLUGIN_PKG]),
    // `worker` bare: apps/worker once mono-11a lifts it out, and until then
    // apps/web/src/worker itself, which NO_WEB_INTO_WORKER already fences.
    climbsInto(['apps/worker', 'plugins', 'worker']),
  ].join('|'),
  message:
    'The web app imports @spaces/core and @spaces/sdk, never a plugin and never the worker (docs/spec-plugin-sdk.md §2: "web → core, sdk. Never plugins/*, never worker"). Plugin code runs in apps/worker only; web renders from manifests.',
}
// Unproven until apps/worker exists — mono-11a (SPA-181) lifts the worker out
// of apps/web/src/worker and is where this zone gets its failing-case test.
const WORKER_NEVER_WEB_NEVER_PLUGINS = {
  regex: [
    internal(['web', PLUGIN_PKG]),
    climbsInto(['apps/web', 'plugins', 'web']),
  ].join('|'),
  message:
    'The worker imports @spaces/core and @spaces/sdk, never the web app; a plugin is a runtime import() from the plugin directory, never a compile-time import (docs/spec-plugin-sdk.md §2: "worker → core, sdk. Never plugins/* at compile time").',
}
// Unproven against the real package until sdk-3 births it; proved against
// packages/config/fixtures/sdk.
const SDK_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    internal(['core', 'db', 'web', 'worker', PLUGIN_PKG]),
    '^#/',
    climbsInto(['apps', 'plugins', 'packages/(core|db)', 'core', 'db']),
  ].join('|'),
  message:
    '@spaces/sdk imports effect and zod and nothing internal — if sdk ever needs core, the contract leaked (docs/spec-plugin-sdk.md §2: "sdk → effect, zod. Nothing internal").',
}
// Unproven against a real plugin until plugins/* exists; proved against
// packages/config/fixtures/plugins.
const PLUGIN_IMPORTS_SDK_ONLY = {
  regex: [
    internal(['core', 'db', 'web', 'worker', PLUGIN_PKG]),
    '^#/',
    // No bare sibling names here: plugins/* is not in packages/, so a climb
    // to core or db spells `packages/`, and a plugin may have a `core/` of
    // its own.
    climbsInto(['apps', 'plugins', 'packages']),
  ].join('|'),
  message:
    'A plugin imports @spaces/sdk only, never @spaces/core and never @spaces/db — it returns claims and core routes them (docs/spec-plugin-sdk.md §2: "plugins/* → sdk. Never core, db"; CONTEXT.md "Plugin architecture").',
}

export default [
  ...tanstackConfig,
  // import-x's default resolver knows .mjs/.cjs/.js/.json/.node and nothing
  // else, so every TypeScript specifier came back unresolved and every rule
  // that needs a resolved path — `import/no-restricted-paths`, the server-only
  // zone below — silently matched nothing. Resolving `.ts`/`.tsx` and the
  // `#/` subpath imports (read from each package's own package.json `imports`
  // field, which is why this needs no path map) is what makes the zone real.
  {
    settings: {
      'import-x/resolver-next': [
        createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.json'],
        }),
      ],
    },
  },
  // The Instrument vocabulary, enforced (SPA-16). This replaces the CLAUDE.md
  // gate-5 grep, which read whole files and so could not tell `rounded` the
  // class from "rounded" the word in a comment. The rule reads className
  // literals and cn()/cva() string arguments only, and names the Instrument
  // replacement in every message. Running here means gate 4 and the pre-commit
  // hook cover it.
  // The rule source is plain JS (eslint.base.js loads it directly) and is
  // exercised by apps/web/src/lib/design-tokens.test.ts, so it is not itself linted.
  { ignores: ['packages/config/eslint-rules/*.js'] },
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { instrument },
    rules: { 'instrument/vocabulary': 'error' },
  },
  // Just the two classic hooks rules — the v7 "recommended" set adds React
  // Compiler rules that fight TanStack Table's API.
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // Dropped promises are silent data loss in server code; misused catches
  // promise-returning callbacks passed where void is expected. JSX event
  // handlers (onClick={async ...}) are idiomatic React — exempted.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // Architecture seams as lint rules (CLAUDE.md traps, mechanically enforced):
  // client code never reaches server internals, Effect never crosses into React.
  {
    files: ['apps/web/src/routes/**', 'apps/web/src/components/**'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        { basePath: ROOT, zones: [SERVER_ONLY, NO_WEB_INTO_WORKER] },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'effect',
              message:
                'Effect never crosses into React — the seam is effectFn() / HttpApi handlers (CONTEXT.md "Backend paradigm").',
            },
            {
              name: 'effect/unstable/httpapi',
              message:
                'The HttpApi layer lives in apps/web/src/lib/rpc/api.ts and nowhere else — a route mounts it by dynamic import inside its server handler (see routes/api/v1/$.ts).',
            },
          ],
          // Every other `effect/*` subpath too: a `paths` entry matches its
          // specifier exactly, and `effect/unstable/http` is as much Effect as
          // `effect` is. httpapi is left out of the regex only so it reports
          // once, with its own message.
          patterns: [
            {
              regex: '^effect/(?!unstable/httpapi$)',
              message:
                'Effect never crosses into React — the seam is effectFn() / HttpApi handlers (CONTEXT.md "Backend paradigm").',
            },
            // …and the web boundary (spec §2), carried here because this
            // block owns `no-restricted-imports` for routes/ and components/
            // and a later block would replace these options, not extend them.
            WEB_NEVER_PLUGINS_NEVER_WORKER,
          ],
        },
      ],
    },
  },
  // The web boundary over the rest of the app (spec §2, SPA-180). routes/ and
  // components/ carry it in the block above; the worker directory is in scope
  // here — it is web code until mono-11a, and a plugin import is banned there
  // as everywhere in web.
  {
    files: ['apps/web/src/**'],
    ignores: ['apps/web/src/routes/**', 'apps/web/src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [WEB_NEVER_PLUGINS_NEVER_WORKER] },
      ],
    },
  },
  // The other five package boundaries (spec §2, SPA-180). One block per
  // package directory; the unproven three are named as such above, and the
  // two fixture directories are the sdk and plugin zones' targets until the
  // packages exist. The failing cases: `import { fmtMoney } from
  // '@spaces/core/portfolio/format'` in packages/db, and `import { db } from
  // '@spaces/db'` in fixtures/plugins — each fails with its rule's message.
  {
    files: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [DB_IMPORTS_NOTHING_INTERNAL] },
      ],
    },
  },
  {
    files: ['packages/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [CORE_IMPORTS_DB_AND_SDK_ONLY] },
      ],
    },
  },
  {
    files: ['apps/worker/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [WORKER_NEVER_WEB_NEVER_PLUGINS] },
      ],
    },
  },
  {
    files: ['packages/sdk/**', 'packages/config/fixtures/sdk/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [SDK_IMPORTS_NOTHING_INTERNAL] },
      ],
    },
  },
  {
    files: ['plugins/**', 'packages/config/fixtures/plugins/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [PLUGIN_IMPORTS_SDK_ONLY] },
      ],
    },
  },
  // …and the worker edge again, over the rest of the app. The block above
  // owns routes/ and components/, where this rule's options would be replaced
  // rather than extended, so those two are excluded here and carry the zone in
  // their own list. The worker excludes itself: it is allowed to be the worker.
  {
    files: ['apps/web/src/**'],
    ignores: [
      'apps/web/src/routes/**',
      'apps/web/src/components/**',
      'apps/web/src/worker/**',
    ],
    rules: {
      'import/no-restricted-paths': [
        'error',
        { basePath: ROOT, zones: [NO_WEB_INTO_WORKER] },
      ],
    },
  },
  // Both syntax bans, over every package's source. Intl compact notation
  // differs Node vs Chrome → hydration failures, so fmtMoney
  // (packages/core/src/portfolio/format.ts) hand-rolls compact — and since
  // SPA-144 moved both format modules to @spaces/core, the ban has to cover
  // that package or the one place the trap can still be written is the one
  // place nothing watches. And attribute values have one write path
  // (CONTEXT.md "Backend paradigm" #9): setValues validates, diffs, logs
  // attribute_event and materializes reference links in one transaction, all
  // four of which a direct `.update(entity).set({ values })` skips. The glob
  // is the workspace, not one app (SPA-174): the attribute engine is moving
  // into packages/core, and a package that appears later is covered the day
  // it appears rather than the day someone remembers.
  {
    files: ['apps/*/src/**', 'packages/*/src/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_INTL_NUMBER_FORMAT,
        NO_DIRECT_ENTITY_VALUES,
      ],
    },
  },
  // The two format modules are where compact notation is hand-rolled, so they
  // are the only files allowed to construct an Intl.NumberFormat. They moved
  // with the rest of the pure half (SPA-144); the exemption moved with them.
  {
    files: [
      'packages/core/src/format.ts',
      'packages/core/src/portfolio/format.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', NO_DIRECT_ENTITY_VALUES] },
  },
  // setValues itself, the merge executor (which rewrites values under its own
  // snapshot contract), the seeds and the tests set values directly. The two
  // modules moved to @spaces/core with SPA-174/175 and the exemption moved
  // with them.
  {
    files: [
      'packages/core/src/writes/attributes/values.ts',
      'packages/core/src/writes/entities/merge.ts',
      'apps/web/src/lib/seeds/**',
      'apps/web/src/**/*.test.ts',
      'packages/core/src/**/*.test.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', NO_INTL_NUMBER_FORMAT] },
  },
  // The cast ratchet (SPA-151): a type is a claim the compiler checked, not
  // one the author asserted. Data crossing a boundary gets its type once —
  // at the jsonb column's $type<>() or at a decode — and never again
  // downstream. The residual DOM/React/third-party-generic casts each carry
  // a per-line disable with a reason, so `grep -c` sees the count and it
  // only goes down. no-unsafe-* stays off: drizzle's inferred types trip it
  // too often to be signal.
  {
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'packages/db/src/**/*.ts',
      'packages/core/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  // Guard against accidental full-table update/delete (portfolio event
  // tables are append-only by design). packages/db is in scope too: the
  // schema moved there in SPA-142 and so did `heartbeat.ts`, which writes;
  // packages/core since SPA-174, when its `src/writes/` half began to.
  {
    files: ['apps/web/src/**', 'packages/db/src/**', 'packages/core/src/**'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': [
        'error',
        { drizzleObjectName: ['db', 'tx'] },
      ],
      'drizzle/enforce-update-with-where': [
        'error',
        { drizzleObjectName: ['db', 'tx'] },
      ],
    },
  },
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    ignores: [
      // The two root shims and the two files they re-export: `// @ts-check`
      // JavaScript in no tsconfig's program, which the type-aware rules would
      // otherwise refuse to parse.
      'eslint.config.js',
      'prettier.config.js',
      'packages/config/eslint.base.js',
      'packages/config/prettier.base.js',
      // Agent worktrees are separate checkouts; each lints itself.
      '.claude/worktrees/**',
      // Build artifacts — regenerated, never linted.
      '**/.output/**',
      '**/.nitro/**',
      '**/.tanstack/**',
      '**/dist/**',
    ],
  },
]

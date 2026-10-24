//  @ts-check

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tanstackConfig } from '@tanstack/eslint-config'
import { createNodeResolver } from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
// @ts-expect-error eslint-plugin-drizzle 0.2.3 ships no declaration file; the day it does, this line fails and comes out.
import drizzle from 'eslint-plugin-drizzle'
import * as astroParser from 'astro-eslint-parser'
import tsParser from '@typescript-eslint/parser'
import instrument from './eslint-rules/vocabulary.js'
import comments from './eslint-rules/history.js'

// The repo root, absolute so the zones resolve the same from every cwd.
// - Not named eslint.config.js: ESLint looks its config up from the cwd, and
//   under `@spaces/config#lint` the base would be found first and every
//   root-relative glob below would re-base here.
// - `import/no-restricted-paths` resolves zones against `basePath`; a relative
//   '.' is eslint's cwd, which is `apps/web` under turbo, and the zones go silent.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// `Intl.NumberFormat`, banned everywhere but the two format modules, and
// `entity.values`, written only by setValues. Both are `no-restricted-syntax`,
// and a flat-config block does not merge a rule's options with an earlier
// block's — it replaces them. Declared once here and composed below so neither
// selector can shadow the other.
const NO_INTL_NUMBER_FORMAT = {
  selector:
    "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
  message:
    'Use fmtMoney (packages/core/src/portfolio/format.ts) or the shared formatters in packages/core/src/format.ts — Intl.NumberFormat compact output differs between Node and Chrome (hydration trap).',
}
// The web app never imports the worker. This resolved-path zone catches a
// relative reach into apps/worker; the specifier form (`@spaces/worker`, a
// climb spelled `worker/`) is WEB_NEVER_PLUGINS_NEVER_WORKER below. Declared
// once and composed below because a later flat-config block replaces an
// earlier block's options for the same rule rather than merging with them.
const NO_WEB_INTO_WORKER = {
  target: './apps/web/src',
  from: './apps/worker',
  message:
    'The web app never imports the worker (spec §2). Queue names and the sender live in @spaces/core/queue/*.',
}
const SERVER_ONLY = {
  target: './apps/web/src',
  from: './apps/web/src/lib/server',
  message:
    'Server helpers are server-only. Client code imports from the server-fns barrel (apps/web/src/lib/server-fns.ts).',
}
// @spaces/db in a module the browser loads ships drizzle and every table the
// import reaches. Client code reads enum value lists from @spaces/core or a
// local literal.
const NO_DB_IN_CLIENT = {
  regex: '^@spaces/db(/|$)',
  allowTypeImports: true,
  message:
    '@spaces/db is server-only in apps/web — a value import from client code ships the drizzle schema to the browser. Read enum value lists from @spaces/core (or a local literal), use `import type`, or move the code into a server module (DB_SERVER_MODULES in packages/config/eslint.base.js).',
}
// The apps/web modules allowed a value import of @spaces/db: server
// directories, server routes, boot and seeds, tests.
// - lib/server is client-imported through the server-fns barrel; only
//   handler bodies are stripped, so a module-level table reference there
//   still ships. scripts/check-client-bundle.sh catches that after the build.
const DB_SERVER_MODULES = [
  'apps/web/src/db/**',
  'apps/web/src/test/**',
  'apps/web/src/**/*.test.{ts,tsx}',
  'apps/web/src/routes/api/**',
  'apps/web/src/lib/server/**',
  'apps/web/src/lib/auth.ts',
  'apps/web/src/lib/{ai,arrival,ask,deals,documents,glossary,import,inbox,integrations,interactions,mcp,members,notes,people,portfolio,records,rpc,search,seeds,spaces,tasks,timeline,tokens,views}/**',
]
// Client modules inside those directories (the client build's module graph):
// they stay fenced.
const CLIENT_MODULES_IN_SERVER_DIRS = [
  'apps/web/src/lib/ai/lanes.ts',
  'apps/web/src/lib/ai/providers/{ids,meta}.ts',
  'apps/web/src/lib/ai/providers/embed/ids.ts',
  'apps/web/src/lib/arrival/input.ts',
  'apps/web/src/lib/ask/{answer,dock-store,page-scope,thread-list,types}.ts',
  'apps/web/src/lib/documents/{file-against,key-terms-gate,note-drop,project,read-deck-gate,registry,upload,uri-list,vision-gate}.ts',
  'apps/web/src/lib/import/upload.ts',
  'apps/web/src/lib/inbox/to-review.ts',
  'apps/web/src/lib/records/readout-format.ts',
  'apps/web/src/lib/integrations/job-status-view.ts',
  'apps/web/src/lib/search/waves.ts',
  'apps/web/src/lib/tasks/focus.ts',
  'apps/web/src/lib/timeline/stamp.ts',
  'apps/web/src/lib/tokens/scopes.ts',
]
const NO_DIRECT_ENTITY_VALUES = {
  selector:
    "CallExpression[callee.property.name='set'][callee.object.callee.property.name='update'][callee.object.arguments.0.name='entity'] > ObjectExpression > Property[key.name='values']",
  message:
    'entity.values has one write path — go through setValues (packages/core/src/writes/attributes/values.ts) so validation, attribute_event, and reference links stay in one transaction.',
}

// Package boundaries, one `no-restricted-imports` pattern per package. The
// turbo graph (each package.json) is the allow list; these are the "never"
// clauses, spelled as a violation would be written: `@spaces/<name>`, the `#/`
// alias, or a relative climb into another package.
// - A specifier ban, not a resolved-path zone: it fires on an uninstalled or
//   not-yet-existing package and on `import type` — the edge is the dependency,
//   not the bundle. (A resolved zone would also follow pnpm's symlinks and
//   report `@spaces/core` from packages/db twice.)
// - A climb is matched by the directory it lands in, so each package bans its
//   siblings' bare names; unambiguous only while no package has a
//   subdirectory named for a sibling package.
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
    // `worker` bare: `../../worker/` from apps/web/src is apps/worker;
    // NO_WEB_INTO_WORKER is the resolved-path form of the same edge.
    climbsInto(['apps/worker', 'plugins', 'worker']),
  ].join('|'),
  message:
    'The web app imports @spaces/core and @spaces/sdk, never a plugin and never the worker (docs/spec-plugin-sdk.md §2: "web → core, sdk. Never plugins/*, never worker"). Plugin code runs in apps/worker only; web renders from manifests.',
}
// The worker never imports the web app, with one opening: its jobs still use
// server modules in apps/web/src/lib, so it may cross into `lib/**` (and its
// tests into `test/**`) through the `#web/*` alias, and nowhere else.
// - `#/` is banned outright: the worker has none, and that spelling would hide
//   the crossing. A relative climb is banned so every crossing greps as `#web/`.
// - The fence narrows as lib/ moves into core; when the list is empty, the
//   alias and this comment go.
// The crossing list (`grep -rho "'#web/[^']*'" apps/worker/src`), shipping
// code first:
//   lib/ai/{attribute-run, classify-document, column-run, complete,
//     embed-backfill, embed-document, embed-source, key-terms, read-deck,
//     read-deck-summarize, recorded-note-tasks, run, sensitivity-for,
//     suggest-spaces, summarize, summarize-email, vision}
//   lib/arrival/{meeting, poll, schedule, synced}
//   lib/documents/{blob-refs, fetch-guard, on-extracted, refile, retain,
//     vision-gate}
//   lib/glossary/link-terms · lib/import/commit · lib/queue · lib/server/env
// and, from tests only:
//   lib/ai/{embed-chunks, embedding-pin, propose, route, providers/embed/ids,
//     providers/embed/settings}
//   lib/arrival/{fixtures, noise, settings}
//   lib/documents/{attach-link, clip, read-deck-gate, shelf, space-sources}
//     · lib/import/{mapping, plan, stage} · lib/inbox/queue
//     · lib/integrations/{job-status, ledger, status}
//     · lib/interactions/{email-drafts, email-send}
//   lib/rpc/{api, versions} · lib/search/{query, query-embedding}
//   lib/server/shared · lib/tokens/store
//   test/{fake-imap, fake-ollama, minimal-pdf, queue-stub, reseed}
const WORKER_NEVER_WEB_NEVER_PLUGINS = {
  regex: [
    internal(['web', PLUGIN_PKG]),
    '^#/',
    '^#web/(?!lib/|test/)',
    climbsInto(['apps/web', 'plugins', 'web']),
  ].join('|'),
  message:
    'The worker imports @spaces/core and @spaces/sdk, never the web app; a plugin is a runtime import() from the plugin directory, never a compile-time import (docs/spec-plugin-sdk.md §2: "worker → core, sdk. Never plugins/* at compile time"). Until the modules under apps/web/src/lib move into core, the one allowed crossing is `#web/lib/*` (and `#web/test/*` from a test), listed in the zone comment — never `#/`, never a relative path into apps/web.',
}
// The browser suite tests the product from outside (HTTP, Chromium, the boot
// entry and server bundle as processes), so it imports nothing internal. A
// spec reaching into @spaces/db would test the module, not the product; the
// harness talks to Postgres through `pg` like any client.
const E2E_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    '^@spaces/',
    '^#',
    climbsInto(['apps', 'packages', 'plugins', 'web', 'worker']),
  ].join('|'),
  message:
    '@spaces/e2e imports nothing internal — no @spaces/* package, no #/ alias, no relative path into another package. It drives the built app over HTTP and in a browser, and boots it as a process (apps/e2e/harness/instance.ts); a spec that imported the code would be testing the module, not the product.',
}
// The marketing and docs site (Vercel, never in the image) imports nothing
// internal. An import from @spaces/core would pull the site into the image's
// prune graph and couple its build to the app's toolchain; what it shows of
// the product it copies or syncs as files at build time. Applies to .astro
// frontmatter too, via the parser block below.
const SITE_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    '^@spaces/',
    '^#',
    climbsInto(['apps', 'packages', 'plugins', 'web', 'worker', 'e2e']),
  ].join('|'),
  message:
    '@spaces/site imports nothing internal — no @spaces/* package, no # alias, no relative path into another package. It is marketing and docs, deployed to Vercel and never in the image (docs/spec-plugin-sdk.md §2); copy what it needs to show, or sync it as a file from docs/assets (apps/site/README.md).',
}
// The "nothing internal" half; third-party imports are pinned by the sdk's
// package test. Proved on the real package by the sdk's fence test.
const SDK_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    internal(['core', 'db', 'web', 'worker', PLUGIN_PKG]),
    '^#/',
    climbsInto(['apps', 'plugins', 'packages/(core|db)', 'core', 'db']),
  ].join('|'),
  message:
    '@spaces/sdk imports effect, zod and tldts and nothing internal — if sdk ever needs core, the contract leaked (docs/spec-plugin-sdk.md §2: "sdk → effect, zod, tldts. Nothing internal"; D55).',
}
// Proved on the echo fixture plugin by the sdk's fence test.
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
    'A plugin imports @spaces/sdk only, never @spaces/core and never @spaces/db — it calls the ports the host provides, and each port writes through its lane (docs/spec-plugin-sdk.md §2: "plugins/* → sdk. Never core, db"; D52; CONTEXT.md "Plugin architecture").',
}

export default [
  ...tanstackConfig,
  // import-x's default resolver knows no TypeScript, and every rule needing a
  // resolved path (`import/no-restricted-paths`, the server-only zone) would
  // silently match nothing. `#/` comes from each package.json's `imports`
  // field, so no path map is needed.
  {
    settings: {
      'import-x/resolver-next': [
        createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.json'],
        }),
      ],
    },
  },
  // The Instrument vocabulary: reads className literals and cn()/cva() string
  // arguments only, and names the replacement in every message.
  // The rule source is plain JS loaded directly and exercised by the design
  // tokens test, so it is not itself linted.
  { ignores: ['packages/config/eslint-rules/*.js'] },
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { instrument },
    rules: { 'instrument/vocabulary': 'error' },
  },
  // Comments describe the current code; ids and dates belong in the commit.
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: ['**/routeTree.gen.ts', 'packages/db/drizzle/**'],
    plugins: { comments },
    rules: { 'comments/no-history': 'error' },
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
            // …and the web boundary, carried here because this
            // block owns `no-restricted-imports` for routes/ and components/
            // and a later block would replace these options, not extend them.
            WEB_NEVER_PLUGINS_NEVER_WORKER,
          ],
        },
      ],
    },
  },
  // The web boundary over the rest of the app. routes/ and components/ carry
  // it in the block above.
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
  // The client fence: @spaces/db is server-only in apps/web — fenced
  // everywhere, then opened for the modules DB_SERVER_MODULES names.
  // - Its own rule name, so it composes with the blocks above instead of
  //   replacing their `no-restricted-imports` options.
  // - Type imports erase and stay allowed.
  {
    files: ['apps/web/src/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [NO_DB_IN_CLIENT] },
      ],
    },
  },
  {
    files: DB_SERVER_MODULES,
    ignores: CLIENT_MODULES_IN_SERVER_DIRS,
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
  // The other package boundaries, one block per package directory. The sdk
  // and plugin ones are asserted by the sdk's fence test.
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
    files: ['apps/e2e/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [E2E_IMPORTS_NOTHING_INTERNAL] },
      ],
    },
  },
  // .astro files are parsed only so the zone below can read their imports:
  // the frontmatter goes through the TypeScript parser, without type
  // information, and no rule set is turned on here. Without this block
  // `eslint .` in apps/site never opens an .astro file, and an import there
  // would pass the zone unread.
  {
    files: ['apps/site/**/*.astro'],
    languageOptions: {
      parser: astroParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.astro'],
        sourceType: 'module',
      },
    },
  },
  {
    files: ['apps/site/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [SITE_IMPORTS_NOTHING_INTERNAL] },
      ],
    },
  },
  {
    files: ['packages/sdk/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [SDK_IMPORTS_NOTHING_INTERNAL] },
      ],
    },
  },
  {
    files: ['plugins/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [PLUGIN_IMPORTS_SDK_ONLY] },
      ],
      // Clock is not a port: Effect ships one, and a job that reads the wall
      // clock directly cannot be tested at a fixed time. `Date.now()` and a
      // bare `new Date()` are asserted by the sdk's fence test.
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message:
            'Plugin code reads time through Effect (`Clock.currentTimeMillis`, `DateTime.now`) — Clock is not an SDK port because Effect ships one, and the test Layers can fix it (sdk-5).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Plugin code reads time through Effect (`Clock.currentTimeMillis`, `DateTime.now`), not `new Date()` — Clock is not an SDK port because Effect ships one (sdk-5).',
        },
      ],
    },
  },
  // …and the worker edge again, over the rest of the app. The block above
  // owns routes/ and components/, where this rule's options would be replaced
  // rather than extended, so those two are excluded here and carry the zone in
  // their own list.
  {
    files: ['apps/web/src/**'],
    ignores: ['apps/web/src/routes/**', 'apps/web/src/components/**'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        { basePath: ROOT, zones: [NO_WEB_INTO_WORKER] },
      ],
    },
  },
  // Both syntax bans, over every package's source, so a new package is
  // covered the day it appears.
  // - Intl compact notation differs Node vs Chrome → hydration failures, so
  //   fmtMoney hand-rolls compact.
  // - Attribute values have one write path: setValues validates, diffs, logs
  //   attribute_event and materializes reference links in one transaction,
  //   all of which a direct `.update(entity).set({ values })` skips.
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
  // are the only files allowed to construct an Intl.NumberFormat.
  {
    files: [
      'packages/core/src/format.ts',
      'packages/core/src/portfolio/format.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', NO_DIRECT_ENTITY_VALUES] },
  },
  // setValues itself, the merge executor (which rewrites values under its own
  // snapshot contract), the seeds and the tests set values directly.
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
  // The cast ratchet: a type is a claim the compiler checked, not
  // one the author asserted. Data crossing a boundary gets its type once —
  // at the jsonb column's $type<>() or at a decode — and never again
  // downstream. The residual DOM/React/third-party-generic casts each carry
  // a per-line disable with a reason, so `grep -c` sees the count and it
  // only goes down. no-unsafe-* stays off: drizzle's inferred types trip it
  // too often to be signal.
  {
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'apps/worker/src/**/*.ts',
      'apps/site/src/**/*.ts',
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
  // tables are append-only by design), in every package that writes.
  {
    files: [
      'apps/web/src/**',
      'apps/worker/src/**',
      'packages/db/src/**',
      'packages/core/src/**',
    ],
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
      // Astro's generated type declarations (`astro sync`, `astro check`).
      '**/.astro/**',
    ],
  },
]

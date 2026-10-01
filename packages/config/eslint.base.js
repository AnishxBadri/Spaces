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
// be a rule rather than a convention — and since SPA-181 the worker is
// `apps/worker`, its own package, so this resolved-path zone catches a
// relative reach into it; the specifier form (`@spaces/worker`, a climb
// spelled `worker/`) is WEB_NEVER_PLUGINS_NEVER_WORKER below. Declared once
// and composed below because a later flat-config block replaces an earlier
// block's options for the same rule rather than merging with them — the trap
// that silenced one of these selectors for a whole cycle (SPA-101).
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
// Each rule's `files` is the package directory. The sdk and plugin zones
// were written by SPA-180 before either package existed and proved against
// placeholder directories under packages/config/fixtures; SPA-191 (sdk-3)
// birthed `packages/sdk` and the first plugin (`plugins/_fixtures/echo`)
// inside the fence, retired the placeholders, and proves both zones on the
// real packages (`packages/sdk/src/fence.test.ts`). The worker zone was
// proved the same way when mono-11a (SPA-181) lifted `apps/worker` out of
// apps/web/src/worker, with one deliberate opening described at the zone.
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
    // `worker` bare: `../../worker/` from apps/web/src is apps/worker since
    // SPA-181; NO_WEB_INTO_WORKER is the resolved-path form of the same edge.
    climbsInto(['apps/worker', 'plugins', 'worker']),
  ].join('|'),
  message:
    'The web app imports @spaces/core and @spaces/sdk, never a plugin and never the worker (docs/spec-plugin-sdk.md §2: "web → core, sdk. Never plugins/*, never worker"). Plugin code runs in apps/worker only; web renders from manifests.',
}
// Proved since SPA-181 (mono-11a), which lifted the worker out of
// apps/web/src/worker into apps/worker — with one opening the spec does not
// have, taken on the issue's option (a): the job modules still import server
// modules that have not left apps/web/src/lib (the AI lanes, arrival,
// documents, import, search, the queue sender), so the worker may cross into
// `apps/web/src/lib/**` — and its tests into `apps/web/src/test/**` — through
// the `#web/*` alias its tsconfig declares, and nowhere else: `#/` is banned
// here outright (the worker has no `#/` of its own, and a web module reached
// by that spelling would hide the crossing), and a relative climb into
// apps/web is banned so every crossing is greppable as `#web/`. The fence
// narrows as lib/ moves into core; the day the list below is empty, the
// alias and this paragraph go. SPA-201 (sdk-8a) took documents/{birth,
// intake, prepare} off it: they are `@spaces/core/writes/documents/*` now.
//
// The crossing list (2026-10-01, `grep -rho "'#web/[^']*'" apps/worker/src`),
// shipping code first:
//   lib/ai/{attribute-run, classify-document, column-run, complete,
//     embed-backfill, embed-document, embed-source, key-terms, read-deck,
//     read-deck-summarize, run, sensitivity-for, suggest-spaces, summarize,
//     vision}
//   lib/arrival/{poll, schedule}
//   lib/documents/{blob-refs, fetch-guard, on-extracted, vision-gate}
//   lib/glossary/link-terms · lib/import/commit · lib/queue · lib/server/env
// and, from tests only:
//   lib/ai/{embed-chunks, embedding-pin, propose, route, providers/embed/ids,
//     providers/embed/settings}
//   lib/arrival/{fixtures, settings}
//   lib/documents/{clip, read-deck-gate, shelf, space-sources}
//     · lib/import/{mapping, plan} · lib/inbox/queue
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
// The browser suite (SPA-184) tests the product from outside — over HTTP,
// through a real Chromium, and by running the boot entry and the server
// bundle as processes. It imports nothing internal: no workspace package,
// no `#/` alias, no relative climb into another package. A spec that
// reached into @spaces/db for a row count would be testing the module, not
// the product; the harness talks to Postgres through `pg` like any client.
const E2E_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    '^@spaces/',
    '^#',
    climbsInto(['apps', 'packages', 'plugins', 'web', 'worker']),
  ].join('|'),
  message:
    '@spaces/e2e imports nothing internal — no @spaces/* package, no #/ alias, no relative path into another package. It drives the built app over HTTP and in a browser, and boots it as a process (apps/e2e/harness/instance.ts); a spec that imported the code would be testing the module, not the product.',
}
// The marketing and docs site (docs/spec-plugin-sdk.md §2: `apps/site/`,
// Vercel, never in the image). It is a static page about the product, so it
// imports nothing internal, exactly like the browser suite: no workspace
// package, no `#` alias, no relative climb into another package. A feature
// list imported from @spaces/core would put the site in the image's prune
// graph the day core gained a dependency on it, and would couple a Vercel
// build to the app's toolchain. What the site shows of the product it copies
// (the Instrument tokens into src/styles/site.css) or syncs as files at build
// time (docs/assets → public/, src/integrations/sync-assets.ts), never
// imports. The failing case: `import { fmtMoney } from
// '@spaces/core/portfolio/format'` in apps/site/src, in a .ts file or an
// .astro frontmatter alike (the .astro parser block below is what makes the
// second one visible to this rule).
const SITE_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    '^@spaces/',
    '^#',
    climbsInto(['apps', 'packages', 'plugins', 'web', 'worker', 'e2e']),
  ].join('|'),
  message:
    '@spaces/site imports nothing internal — no @spaces/* package, no # alias, no relative path into another package. It is marketing and docs, deployed to Vercel and never in the image (docs/spec-plugin-sdk.md §2); copy what it needs to show, or sync it as a file from docs/assets (docs/site.md).',
}
// Proved on the real package by packages/sdk/src/fence.test.ts (SPA-191).
// Third-party imports are the package.json's business, pinned by
// packages/sdk/src/package.test.ts (D55); this zone is the "nothing
// internal" half.
const SDK_IMPORTS_NOTHING_INTERNAL = {
  regex: [
    internal(['core', 'db', 'web', 'worker', PLUGIN_PKG]),
    '^#/',
    climbsInto(['apps', 'plugins', 'packages/(core|db)', 'core', 'db']),
  ].join('|'),
  message:
    '@spaces/sdk imports effect, zod and tldts and nothing internal — if sdk ever needs core, the contract leaked (docs/spec-plugin-sdk.md §2: "sdk → effect, zod, tldts. Nothing internal"; D55).',
}
// Proved on the first plugin, plugins/_fixtures/echo, by
// packages/sdk/src/fence.test.ts (SPA-191).
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
  // components/ carry it in the block above.
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
  // The other package boundaries (spec §2, SPA-180). One block per package
  // directory. The failing cases: `import { fmtMoney } from
  // '@spaces/core/portfolio/format'` in packages/db, and `import { db } from
  // '@spaces/db'` in a plugin — each fails with its rule's message, and the
  // sdk and plugin ones are asserted by packages/sdk/src/fence.test.ts.
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
      // Clock is not a port (sdk-5): Effect ships one, and a job that reads
      // the wall clock directly cannot be tested at a fixed time. The
      // failing cases, asserted by packages/sdk/src/fence.test.ts:
      // `Date.now()` and a bare `new Date()` in a plugin.
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
  // their own list. (The worker used to exclude itself here; since SPA-181 it
  // is apps/worker and not under this glob at all.)
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
  // tables are append-only by design). packages/db is in scope too: the
  // schema moved there in SPA-142 and so did `heartbeat.ts`, which writes;
  // packages/core since SPA-174, when its `src/writes/` half began to;
  // apps/worker since SPA-181, when the jobs moved there.
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

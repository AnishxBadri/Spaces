//  @ts-check

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tanstackConfig } from '@tanstack/eslint-config'
import { createNodeResolver } from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import drizzle from 'eslint-plugin-drizzle'
import instrument from './eslint-rules/no-v1-tokens.js'

// The directory this file lives in. `import/no-restricted-paths` resolves its
// zones against `basePath`, and a relative '.' means eslint's cwd — which is
// the repo root under CI and the pre-commit hook but `apps/web` under turbo's
// `@spaces/web#lint` task, where the zones then matched nothing and the
// server-only seam went silent (found by SPA-135). Absolute, it is the same
// directory from every cwd.
const ROOT = dirname(fileURLToPath(import.meta.url))

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
    'entity.values has one write path — go through setValues (apps/web/src/lib/attributes/values.ts) so validation, attribute_event, and reference links stay in one transaction.',
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
  // The v1 design vocabulary, out (SPA-16). This replaces the CLAUDE.md gate-5
  // grep, which read whole files and so could not tell `rounded` the class from
  // "rounded" the word in a comment. The rule reads className literals and
  // cn()/cva() string arguments only, and names the Instrument replacement in
  // every message. Running here means gate 4 and the pre-commit hook cover it.
  // The rule source is plain JS (eslint.config.js loads it directly) and is
  // exercised by apps/web/src/lib/design-tokens.test.ts, so it is not itself linted.
  { ignores: ['eslint-rules/*.js'] },
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { instrument },
    rules: { 'instrument/no-v1-tokens': 'error' },
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
                'Effect never crosses into React — the seam is effectFn() / oRPC handlers (CONTEXT.md "Backend paradigm").',
            },
          ],
        },
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
  // Both syntax bans, over the app and over core. Intl compact notation
  // differs Node vs Chrome → hydration failures, so fmtMoney
  // (packages/core/src/portfolio/format.ts) hand-rolls compact — and since
  // SPA-144 moved both format modules to @spaces/core, the ban has to cover
  // that package or the one place the trap can still be written is the one
  // place nothing watches. And attribute values have one write path
  // (CONTEXT.md "Backend paradigm" #9): setValues validates, diffs, logs
  // attribute_event and materializes reference links in one transaction, all
  // four of which a direct `.update(entity).set({ values })` skips.
  {
    files: ['apps/web/src/**', 'packages/core/src/**'],
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
  // snapshot contract), the seeds and the tests set values directly.
  {
    files: [
      'apps/web/src/lib/attributes/values.ts',
      'apps/web/src/lib/entities/merge.ts',
      'apps/web/src/lib/seeds/**',
      'apps/web/src/**/*.test.ts',
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
  // schema moved there in SPA-142 and so did `heartbeat.ts`, which writes.
  {
    files: ['apps/web/src/**', 'packages/db/src/**'],
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
      'eslint.config.js',
      'prettier.config.js',
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

//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'
import drizzle from 'eslint-plugin-drizzle'

export default [
  ...tanstackConfig,
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
    files: ['src/routes/**', 'src/components/**'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: '.',
          zones: [
            {
              target: './src',
              from: './src/lib/server',
              message:
                'Server helpers are server-only. Client code imports from the server-fns barrel (src/lib/server-fns.ts).',
            },
          ],
        },
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
  // Intl compact notation differs Node vs Chrome → hydration failures.
  // fmtMoney (src/lib/portfolio/format.ts) hand-rolls compact; only the
  // format modules may construct Intl.NumberFormat.
  {
    files: ['src/**'],
    ignores: ['src/lib/format.ts', 'src/lib/portfolio/format.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
          message:
            'Use fmtMoney (src/lib/portfolio/format.ts) or the shared formatters in src/lib/format.ts — Intl.NumberFormat compact output differs between Node and Chrome (hydration trap).',
        },
      ],
    },
  },
  // Guard against accidental full-table update/delete (portfolio event
  // tables are append-only by design).
  {
    files: ['src/**'],
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
      '.output/**',
      '.nitro/**',
      '.tanstack/**',
      'dist/**',
    ],
  },
]

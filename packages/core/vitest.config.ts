import { defineConfig } from 'vitest/config'

// No dotenv, no `env`, no `resolve.alias` — and each absence is the point.
//
// The other two suites load `.env.local` because most of what they test talks
// to Postgres. This one must not: mono-7's contract is that every module in
// @spaces/core computes, so `turbo run test --filter=@spaces/core` has to pass
// with DATABASE_URL unset and the database unreachable. Loading the env file
// here would not break that, but it would make the guarantee unfalsifiable —
// a suite that happens to have a connection string is one import away from
// using it. Leaving it out means a module that grows a database dependency
// fails here rather than quietly passing on the operator's machine.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})

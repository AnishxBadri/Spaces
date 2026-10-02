#!/usr/bin/env tsx
import { runMigrations } from '../migrate.ts'

/**
 * Migrations only — the package's own entry point, for anyone who wants the
 * schema brought up without this repo's seeds. The container entrypoint runs
 * the app's boot instead, which calls `runMigrations()` and then seeds.
 */
const outcome = await runMigrations()
process.exit(outcome.kind === 'ok' ? 0 : 1)

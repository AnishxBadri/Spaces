#!/usr/bin/env tsx
import { runMigrations } from '../migrate.ts'

/**
 * Migrations only — the package's own entry point, for anyone who wants the
 * schema brought up without this repo's seeds. The app's boot path is
 * `apps/web/src/db/boot.ts`, which calls `runMigrations()` and then seeds;
 * that is the one the container entrypoint runs.
 */
const outcome = await runMigrations()
process.exit(outcome.kind === 'ok' ? 0 : 1)

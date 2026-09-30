#!/usr/bin/env node
// The bin target is this committed shim, not dist/pack/cli.js itself: pnpm
// links a workspace bin at install time and skips one whose target does not
// exist yet, which in a fresh checkout (CI) is every file under dist/.
import '../dist/pack/cli.js'

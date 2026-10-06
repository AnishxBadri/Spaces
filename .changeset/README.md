# Changesets

A changeset is a markdown file here naming the version lines a change bumps
and how far. Three kinds of line, each versioned on its own (no `fixed`, no
`linked`):

| package               | line         | tag a release pushes | what the tag runs                        |
| --------------------- | ------------ | -------------------- | ---------------------------------------- |
| `spaces` (the root)   | core         | `core@X.Y.Z`         | `release.yml` — the image                |
| `@spaces/plugin-<id>` | each plugin  | `plugin-<id>@X.Y.Z`  | `plugin-release.yml` — tarball, registry |
| `@spaces/sdk`         | the contract | `sdk@X.Y.Z`          | nothing; it records `SDK_VERSION`        |

Every other package is in `ignore` in `config.json`. A new real plugin under
`plugins/` is versioned by default; a new fixture under `plugins/_fixtures/`
must be added to `ignore` (`scripts/release/versioning.test.ts` fails until it
is).

```md
---
'@spaces/plugin-apollo': patch
---

Apollo reads the company's founded year from the new field.
```

A core changeset names `spaces`. `pnpm changeset` (the interactive add) does
not list it, so write that file by hand; the stock `changeset status` and
`changeset version` refuse it for the same reason — changesets does not see a
monorepo's root package. Use the repo's own commands, which hand the root in:

- `pnpm release:status` — the bumps the pending changesets make.
- `pnpm release:version` — apply them (the Version and tag workflow runs this
  to open the release PR). It also rewrites each bumped plugin's
  `src/manifest.ts` `version` and the sdk's `SDK_VERSION`.

A package is bumped only by a changeset that names it: an sdk release
re-releases no plugin.

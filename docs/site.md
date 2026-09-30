# The public site (`apps/site`)

`@spaces/site` is the marketing page and the operator docs: `/`, `/docs`,
`/docs/self-host`, `/docs/architecture`. It is static Astro, deployed to
Vercel, and never in the image (docs/spec-plugin-sdk.md §2). Nothing in the
workspace depends on it, so `turbo prune @spaces/web @spaces/worker --docker`
never reaches it, and it imports nothing internal: the eslint zone
`SITE_IMPORTS_NOTHING_INTERNAL` in `packages/config/eslint.base.js` bans
`@spaces/*`, `#` aliases and relative climbs into another package, in `.ts`
files and in `.astro` frontmatter alike.

## Commands

```
pnpm --filter @spaces/site dev        # http://localhost:4321
pnpm --filter @spaces/site build      # static output in apps/site/dist
pnpm --filter @spaces/site preview
```

`pnpm lint` and `pnpm typecheck` cover it (`eslint .` and `astro check`). It
has no `test` script and is not in the `test` graph. `pnpm build` builds it
along with everything else.

## Screenshots and logos are synced, never copied by hand

`docs/assets/` is the one place the logos (`logo.svg`, `logo-dark.svg`,
`mark.svg`) and the product screenshots (`docs/assets/screenshots/*.png`,
1440×900) live. `apps/site/src/integrations/sync-assets.ts` copies them into
`apps/site/public/` at the start of every `astro dev` and `astro build`, and
those copies are gitignored. To change a picture on the site, change it in
`docs/assets` and rebuild.

The screenshots the page uses are listed in `SCREENSHOTS` in that file. One
that is missing does not fail the build: the page draws a bone panel labelled
`<name>.png · pending` in its place, and the build log says how many arrived
(`synced 3/3 logos and 16/16 screenshots`).

## Design

Instrument, as in the app: the tokens and type steps are copied from
`apps/web/src/styles.css` into `apps/site/src/styles/site.css` (a copy, since
the site imports nothing from the workspace; change both when a token
changes). Fonts are the same three `@fontsource-variable` packages the app
uses, self-hosted, so the site makes no third-party font request. Code blocks
are unhighlighted mono on bone (`markdown.syntaxHighlight: false`).

## Deploying to Vercel

One Vercel project, pointed at this repository:

- **Root Directory:** `apps/site`. Leave "Include files outside the root
  directory in the Build Step" on (the default): the build reads
  `../../docs/assets`.
- Everything else comes from `apps/site/vercel.json`: framework `astro`,
  install `pnpm install --frozen-lockfile --filter @spaces/site...` (pnpm
  finds the workspace root and installs the site and its one internal
  dependency, `@spaces/config`), build `pnpm build`, output `dist`, clean URLs.
- Node: `engines.node` in `apps/site/package.json` is `>=22.12.0`, which Astro
  7 requires; Vercel picks a matching 22.x.

No environment variables are needed. Preview deployments per pull request
work as Vercel's defaults set them up.

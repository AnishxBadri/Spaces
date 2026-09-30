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

## The landing page

`/` is ported from the Paper file "spaces", page "Site · Landing", artboard
"Landing — revised" (1440 wide, a 1120 content column). Top to bottom:

- **Nav** (`components/Nav.astro`, on every page): an ink ribbon (version tag,
  one line, "Get started →"), a sticky 64px bar (mark and serif name, the
  centred links Product · How it works · Self-host · Docs · Changelog, a
  GitHub "Star" button and a pine "Self-host" button), a 1px hairline and the
  dithered `hem` under it.
- **Hero**: eyebrow, the 64px serif headline, the sub, the two actions, then
  the hero stage: Today with the portfolio card and five deal rows over it.
- **How it fits together** (`#how-it-works`, `components/Orbit.astro`): the
  orbit, 1200×840 — a space card at the centre, the AI built into Spaces on
  the inner ring (Claude, OpenAI, Gemini, OpenRouter, Ollama on this box),
  the plugins on the outer "Your box" ring.
- **Four chapters** (01 Research, 02 Screen, 03 Decide, 04 Own): text on one
  side, alternating, and a 680×460 stage on the other with one real screenshot
  in a padded frame (`components/Shot.astro`) and one drawn card
  (`components/Detail.astro`: a memo and its glossary term, a deal's history,
  an AI answer with its sources, a holding's ledger with a voided mark).
- **Closing**: the install block with a blinking block cursor on the
  `closing` plate, then a one-row footer.

Every string and position is data in `src/content/landing.ts`, in the
design's own pixels. The site names every integration as built; nothing on it
says "soon" or "in progress".

`/docs/architecture` leads with the layered stack from the artboard "Stack —
C · Layers" (`components/Stack.astro`, data in `src/content/stack.ts`): the AI
layer with its model sockets, your spaces, the plugins, and the joins between
them, on a 1200×760 mat. `Docs.astro` draws it when a page's frontmatter says
`lead: stack`.

**Fixed-size figures shrink as one piece.** The hero stage, the chapter
stages, the orbit and the stack are drawn at their design size with every card
placed absolutely, inside `components/Scaled.astro`: a size container that
keeps the aspect ratio and scales the stage by `tan(atan2(100cqw, W))` (the
ratio of the two widths as a number, which CSS cannot yet divide out
directly), never above 1. At 1440 everything is at its design size; below
~1240px the orbit and the stack shrink, and nothing scrolls sideways at any
width (checked at 1100 and 390). The closing card reflows instead, so the
install block stays legible. Phone layout beyond that is not designed yet.

## Screenshots, fragments and logos are synced, never copied by hand

`docs/assets/` is the one place the logos (`logo.svg`, `logo-dark.svg`,
`mark.svg`), the integration marks (`docs/assets/logos/*.svg|png`, full
colour: Claude, OpenAI, Gemini, Ollama, OpenRouter, Gmail, Google Calendar,
Google Drive, Apollo, Box, RSS, GitHub, Exa, Fathom) and the product captures
live. `pnpm screenshots` writes both kinds of capture: full pages
(`docs/assets/screenshots/*.png`, 1440×900, used by the README) and
**fragments** (`docs/assets/screenshots/fragments/*.png`, tight 2× crops of
one piece of the product, found by visible text in
`apps/e2e/screenshots/capture.spec.ts`). The page shows six fragments:
`today-main`, `today-portfolio`, `deals-rows`, `spaces-tree`,
`documents-rows`, `portfolio-table`.

`apps/site/src/integrations/sync-assets.ts` runs at the start of every
`astro dev` and `astro build`: it copies the logos into `public/`, the
integration marks into `public/logos/`, converts each fragment to lossless
WebP, and hands the page their sizes as `__FRAGMENTS__`. The copies are
gitignored. To change a picture on the site, re-run `pnpm screenshots` and
rebuild.

## Dither is printed at build time

The only texture on the site is 1-bit ordered (8×8 Bayer) dither, graphite
dots on a 3px cell. Each plate's density field is declared in
`src/dither/stages.ts`, rendered by `src/dither/plate.ts` through sharp, and
served as a static PNG by the `src/pages/dither/[plate].png.ts` endpoint.
Plates are a few kilobytes each and transparent where there is no dot; the
surface underneath is the paper colour. Tone is dot density only; there is no
alpha ramp anywhere.

- `hero`, `research`, `screen`, `decide`, `own`, `closing`: 1px dots on
  paper, gathering toward one corner and thinning to nothing under every card
  the stage lists in `clear`.
- `orbit` (1200×840, 2px dots, on bone): two rings, at radius 240 (width 20,
  tone 0.30) and 370 (26, 0.24), and a surround that darkens past radius 490.
- `mat` (1200×760, 2px dots, on bone): a 56px band around the stack, dense at
  the edge; paper inside it.
- `hem` (1440×9, 2px dots, repeated across): half tone under the nav's
  hairline, gone by its ninth pixel.

Every plate but the hem has a `-b` twin one Bayer step denser (blank cells
stay blank), and the figure swaps between the two on a slow `steps(1)` cycle.

Motion is CSS only and the landing page ships no JavaScript: the plates
breathe, screenshots settle in with a stepped scroll-driven animation
(`animation-timeline: view()`, static where unsupported) and lift with a hard
ink offset under the pointer, and the install command has a blinking cursor.
All of it is off under `prefers-reduced-motion`.

## Design

Instrument, as in the app: the tokens and type steps are copied from
`apps/web/src/styles.css` into `apps/site/src/styles/site.css` (a copy, since
the site imports nothing from the workspace; change both when a token
changes). Fonts are the same three `@fontsource-variable` packages the app
uses, self-hosted, so the site makes no third-party font request; the site
loads Inter and Source Serif with their optical-size axis (`opsz.css`, and
Source Serif's italic), which is what the design's display sizes are drawn
with. Code blocks
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

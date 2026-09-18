# Chapter 6 — routes

`src/routes/` is TanStack Router, file-based. 25 files: a root shell, four
entry routes, an authenticated `_app` layout, and one file per surface under
`_app/`. This chapter covers the shared patterns once, then walks every route.
Read it with the files open; line references point at the tricky parts.

## Patterns shared by every route

Learn these five and most route files become skimmable.

**Loaders, not useQuery.** The root router context carries a `QueryClient`
(`__root.tsx:15-17`), but no route uses `useQuery`. Every route fetches in its
`loader` by calling server functions from `#/lib/server-fns` (the client-safe
barrel), usually with a `Promise.all` fan-out. Mutations call a server
function directly from the component, then `router.invalidate()` to re-run the
loader. There are no query keys to learn. Error handling is
`toast.error(...)` plus, for inline edits, a second `router.invalidate()` that
reverts optimistic state back to server truth (`deals.tsx:188-196`,
`companies.tsx:80-88`). Row types are derived structurally, e.g.
`type Row = Awaited<ReturnType<typeof listCompaniesTable>>[number]`. No
hand-written DTOs.

**Almost no URL state.** The only `validateSearch` in the app is
`join.tsx:18` (the invite token). "Saved views" are localStorage, not URL
state: `useTablePrefs(PREFS_KEY)` persists column visibility and sizing under
versioned keys (frozen as `dealos.companies-table.v1` etc. — renaming resets
layouts with no recovery path). Sorting and text filter are ephemeral
`useState`. The deals table/board toggle is localStorage too (frozen as
`dealos.deals-view`), and it is read post-mount in a `useEffect` so the
server render and the first client paint agree (`deals.tsx:133-140`). That is
a hydration-safety move, not laziness.

**The list-page recipe.** Companies, people, deals, and portfolio all build
the same way: `@tanstack/react-table` with core/sorted/filtered row models,
`columnResizeMode: 'onChange'`, a sticky first column, and shared chrome from
`#/components/table/record-table` (`PageHeader`, `TableToolbar`,
`RecordTable`, `AddColumnButton`). Registry rows from `listRegistry({kind})`
each become a column whose cell is `<ValueEditor variant="cell">` saving
through `updateRecord({id, patch: {[slug]: value}})`. `AddColumnButton` wraps
`AttributeCreateDialog`, so "add a column" literally means "create an
attribute in the registry". Create dialogs offer a `TemplatePicker` that
pre-fills the form visibly and never writes anything itself (the comment
repeats at `companies.tsx:324`, `people.tsx:322`, `deals.tsx:527`).

**Entity resolution shows up in the UI.** `createCompany` / `createPerson`
return `{action: 'created' | 'attached'}`. If a create matched an existing
record by domain or email, the dialog attaches instead of duplicating and
toasts "Matched existing company". Template patches apply only when
`action === 'created'` (`companies.tsx:285`). Adding a domain or email that
another record owns returns `outcome: 'suggested_duplicate'` and toasts a
pointer at the dedupe inbox rather than blocking
(`companies_.$companyId.tsx:446-451`).

**The notes autosave recipe.** Notes detail and the mandate prose share it:
an 800 ms debounce, a `latest` ref holding the BlockNote snapshot, `flush()`
calling `saveNote` with `{bodyJson, bodyMd, mentionIds}`, and a save-state
machine `idle | dirty | saving | saved` with `aria-live` status text. The
editor is always inside `<ClientOnly>` (BlockNote is SSR-unsafe). A failed
save quietly returns to `dirty` and retries on the next change.

## Shell and entry routes

**`__root.tsx`** builds the router root with the `QueryClient` context, head
meta, the stylesheet link, and a `RootDocument` shell (html skeleton,
devtools, `<Scripts/>`). No auth logic here.

**`index.tsx` (`/`)** never renders. Its `beforeLoad` dispatches:
`getSetupState()` says setup is needed → `/setup`; no session → `/login`;
otherwise → `/today`.

**`_app.tsx`** is the authenticated layout. `beforeLoad` fetches the session
and redirects to `/login` without one; the session lands in router context so
children read it via `Route.useRouteContext()`. The loader fetches the
workspace. It renders the shell: fixed 240px sidebar (`AppSidebar`), a mobile
top bar with an overlay drawer, `<Outlet/>`, the `CommandPalette` (controlled
open state, wired to Cmd-K), and the sonner `Toaster`.

**`login.tsx`.** `beforeLoad`: needs-setup → `/setup`, already signed in →
`/today`. The form calls `authClient.signIn.email(...)`; HTTP 429 maps to
"Too many attempts", everything else to a generic "Wrong email or password"
so the form can't be used to enumerate accounts. There is no signup link.
New users arrive by invitation only.

**`setup.tsx`** is the first-run wizard, two steps. The `beforeLoad`
(`setup.tsx:27-38`) has one subtle rule: once an admin exists, only a
signed-in mid-wizard user may stay, and they're forced to step 2. A refresh
must never re-show the admin form, because the setup token is already
consumed. Step 1 collects the setup token (printed to server logs, proving
you own the server), workspace name, and admin credentials, and submits
through `authClient.signUp.email` with an `x-setup-token` header. The token
is enforced inside a Better Auth database hook, not in the route
(`setup.tsx:22-25`), because anyone could hit the signup endpoint directly
and skip route checks. The follow-up `saveWorkspace({name})` failure is
swallowed on purpose: the account and session are already live, and the name
is re-settable in Settings. Step 2 offers demo data (`seedDemo()`) or an
empty start; both land on `/spaces`. Note the asymmetry: setup lands on
`/spaces`, normal login lands on `/today`.

**`join.tsx` (`/join?token=…`)** accepts invites. Existing session →
redirect. The loader calls `getInvitePreview({token})`; invalid tokens render
a dead-end explainer (invites are single-use, 7-day, revocable). A valid
preview shows workspace and role; if the invite is email-locked the email
field is prefilled and disabled. Signup goes through the same Better Auth
hook pattern with an `x-invite-token` header (`join.tsx:13-16`). The link
carries the raw token; the database stores only its hash.

## List pages

**`/companies`.** Loader: `listCompaniesTable()`, `listRegistry({kind:
'company'})`, `countOpenDuplicates()`. Columns: name (links to detail),
domains, the dynamic registry columns, space chips, lastTouched, createdAt.
If open duplicate candidates exist, a banner above the table links `/dedupe`
with the count. The create dialog accepts name and/or domain (either
identifies a company).

**`/people`.** Same recipe. The loader adds `listCompanies()` to power the
create dialog's company select. Email is optional but acts as identity when
present. The empty state hints at the future Gmail/calendar sync arriving
"through the same dedupe gate".

**`/deals`** is the richest list page. Loader: `listDealsTable()` (which
returns `{rows, refNames, userNames}`), the deal registry, and
`dealFunnelStats()`.

- The table/board toggle persists to localStorage (hydration-safe read,
  above). Board mode renders `DealBoard` with the stage options, a merged
  name map for references (`deals.tsx:146-154`), the currency code of the
  value attribute, and `medianDaysInStage` per column. The board header shows
  `TerminalSplit`: all-time invested/passed/lost counts, the headline number
  of the pass-vs-lost post-mortem doctrine (`deals.tsx:389-405`).
- Table mode adds two-level stage chips that filter before the table: group
  chips (Active / Parked / Closed, from the status options' `group` field,
  default `active`) then per-stage chips within the group. An effect clears
  the stage filter if it falls outside the selected group
  (`deals.tsx:180-186`).
- `sortValue` (`deals.tsx:95-121`) is the invariant worth memorizing: every
  column sorts and filters on the string the user sees (option label,
  resolved reference name), never on option ids or uuids.
- `CreateDealDialog` is exported and reused by the company detail page. It
  requires a company, defaults the name to "{Company} deal" (via
  `CompanyNameCapture`, a render-null helper that lazily resolves the picked
  company id to a name), defaults stage to `pre_lead`, and only asks for
  birth-worthy extras (value, source, close date). Everything else waits for
  the record page.

**`/portfolio`** is read-only: no inline edit, no create button, because a
holding is born when a deal reaches Invested, never by hand. Loader:
`listHoldings()` → `{holdings, rollup, baseCurrency}`. Each row's `metrics`
is a Result type; when `metrics.ok` is false (missing FX rates) cells show
"needs fx rate". Columns: invested, current value, realized, ownership
(`actual` %, `~implied` %, or a dash, per the tiered ownership model), MOIC,
gross XIRR, last mark (or "written off"). A header strip shows the rollup,
plus a destructive-toned notice when holdings were excluded for missing FX
rates, pointing at Settings. All money renders through `fmtMoney`.

**`/notes`** is a plain list, no react-table. "New note" calls `createNote()`
then navigates straight into the editor (create-then-edit, no dialog).

**`/spaces`.** The loader returns a flat DFS list with `depth`; indentation
is just `paddingLeft: 8 + depth*20`. The empty state is `MarketsCreator`,
an "active empty state": three inputs asking what markets you look at, which
become root spaces via sequential `createSpace` calls. The inputs are deduped
case-insensitively first because a duplicate would trip the slug-per-parent
unique index (`spaces.tsx:90-99`). The create dialog can also stamp a space
template: `applySpaceTemplate` copies a subtree plus glossary (a copy, not a
reference, `spaces.tsx:183-185`).

**`/tasks`.** Loader: `listTasks({includeDone: true})`. Grouping happens
client-side by comparing ISO date strings against `localToday()`: Overdue /
Today / This week / Later / No date. Entity chips link through
`entityPath()`, and only company/person/deal kinds get links; anything else
renders as plain text, on the theory that a wrong route is worse than no link
(`tasks.tsx:169-170`).

**`/dedupe`** is the duplicate-review inbox. Each candidate pair renders a
reason line (shared identity value, or a name-similarity score), two side
panels of evidence (domains, aliases, spaces, mention counts, created-via),
a "Keep this one" button per side (`mergeDuplicate`), and "Not duplicates"
(`dismissDuplicate`, and dismissed pairs never come back). The system never
merges on a guess; this page is where guesses go to be judged.

**`/mandate`** manages the singular fund strategy. If no mandate exists, a
full-page explainer with one button (`createMandate()`). Otherwise two
columns: a facts rail (stage toggle chips writing `updateMandateFacts`,
free-text geo chips, a check-size editor that strips commas and parses with
`Number()`), and the prose, which is a real note entity edited with the
standard autosave recipe. The stage facts power the outside-mandate hint on
deal records, currently the mandate's only live consumer.

**`/settings`** (1127 lines, the biggest route). The loader fans out eight
fetches; invites load only for admins. Five sections:

1. Workspace rename (admin).
2. Members: role dropdown, suspend/restore, invite creation
   (`createInvite({role, email?})` → single-use URL), revoke.
3. Templates: management only. Rename, archive/restore, and per-template
   `suggestOn` context chips. Creation never happens here; templates are made
   by example from real records.
4. FX rates: base currency plus a sparse manual rate table. A missing rate is
   surfaced, never guessed; upserting a correction recomputes metrics.
5. Objects: the object registry index — every object, system and custom,
   with its live-attribute count and a New object dialog. Each one's
   attributes live on their own route (`/settings/objects/$objectSlug`):
   inline rename, reorder, archive/restore per attribute; `OptionsEditor`
   for select/multi-select/status types. Existing options are renameable but never removable
   (`settings.tsx:1029-1031`); status options carry the
   `group: active | parked | closed` field that the deals page, the board,
   and Today all depend on. The color picker is limited to the shipped
   AA-safe palette, and the swatches must be `DropdownMenuItem`s rather than
   raw buttons or the Radix popover stays open and eats the next click
   (`settings.tsx:1101-1104`).

**`/o/$objectSlug`** is the same recipe generated once for every custom
object: `getObject(slug)` + `listRegistry({objectId})` +
`listObjectRecords({objectId})`, identity column plus the registry columns,
and the create dialog built from the registry. Adding an object adds no
route. Its records live at `/o/$objectSlug/$recordId`.

All four record list pages (companies, people, deals, custom objects) carry
the **view bar** (`components/views/view-bar.tsx`):
chips for the saved views, a filter popover, save/update/delete, and
`?view=` in the URL so a view is linkable. Filter, sort, column visibility
and page extra belong to the view; column widths stay in localStorage,
since they're about the screen and not the view.

## Detail pages — the `x_.$xId` convention

The trailing underscore (`companies_.$companyId`) makes the detail route a
sibling of the list rather than a child, so it takes over the full page
instead of nesting inside the list layout.

**The exemplar: `/companies/$companyId`.** The loader is a seven-way
`Promise.all`: the company, spaces, both relevant registries (company for the
rail, deal for the deals rail and create dialog), the company's deals, the
record timeline, and its documents. First thing after load, the
merge-survivor redirect (`companies_.$companyId.tsx:66-71`): if
`mergedIntoId` is set, throw a redirect to the surviving record, so stale
URLs keep working forever. This is the merge executor's contract surfacing in
the UI.

The layout is a three-column grid `[220px | 1fr | 220px]`:

- Left rail: one `<ValueEditor variant="field">` per registry attribute,
  saving a per-slug patch through `updateRecord`; `DomainsField`, an
  append-only domain list with duplicate-suggestion handling; the
  add-attribute dialog; and `TasksRail`, the entity-scoped tasks widget.
- Center: tabs for activity / notes / files. Activity renders
  `RecordTimeline`; files renders `RecordFiles`; notes lists backlinking
  notes. The tab strip also holds `LogInteractionDialog` and a "Note about
  this" button that creates a note pre-linked to this entity and jumps into
  the editor.
- Right rail: deals (with an inline `CreateDealDialog presetCompany`),
  space tags (chips with hover-remove, plus a depth-indented select to tag),
  people at this company, and "Mentioned in" backlinks.

**Deltas for the rest**, instead of repeating the skeleton:

- **`/deals/$dealId`**: two columns, no right rail; the company lives in the
  header instead, next to the outside-mandate badge
  (`deals_.$dealId.tsx:118-129`), a quiet amber pill that links `/mandate`
  and never blocks anything. The rail passes `refNames` into every
  ValueEditor because deals carry record and actor references.
- **`/people/$personId`**: three columns like companies. The rail swaps
  domains for two `ContactField`s (emails, linkedins, both append-only
  identity lists), and people have no TasksRail. Right rail: link/unlink
  company, backlinks.
- **`/portfolio/$holdingId`** breaks the convention entirely: no registry
  rail, no tabs, no timeline, no merge redirect. It is a financial tear
  sheet: metric stat cards, an FX warning, `OwnershipBlock` (three kinds:
  `actual` with the full per-round history, `implied` for post-money SAFEs
  locked at signing, `cost_basis_only`), then four append-only event
  sections: checks, rounds, marks, distributions. The dialogs are code-owned
  forms, not registry-driven (comment at line 268). Instrument decides the
  fields: shares for priced rounds, cap for SAFEs and CCDs. A write-off is a
  distribution of kind `writeoff` with amount forced to zero and a
  destructive button; the history, and the lesson, stays. Every numeric from
  the loader is a drizzle string and gets `Number(...)` at the render site.
  `AddTrigger` (lines 293-305) documents the Radix `asChild` prop-forwarding
  trap directly in code.
- **`/notes/$noteId`**: the prose register, serif type, `max-w-[72ch]`. The
  title is a bare input sharing the debounced autosave with the body, and
  title-only saves work before the editor has produced a snapshot
  (`notes_.$noteId.tsx:63-71`). `VisibilityToggle` is author-only, shared by
  default. `SpaceFiling` distinguishes filing (the note lives in a space,
  written through `entity_space`) from mentioning (a mere link). The loader
  also fetches `listTermsForNote` so the editor can highlight glossary terms.
- **`/spaces/$spaceId`**: a reading page. Breadcrumb of ancestors, subspace
  chips with an inline creator, filed memos as serif cards with a "Write the
  memo" CTA, tracked companies with stage/geo pills, the `SpaceGlossary`
  component (term CRUD lives inside it), and a "Referenced" section for notes
  that mention the space but are filed elsewhere. Filed never repeats in
  Referenced.

## `/today` — the attention landing

Login lands here. The design note at `today.tsx:16-21` explains why: a
self-hosted app sends no notification emails, so opening the app is the
notification. Every section answers "what needs me"; none answers "how are we
doing".

The loader fetches tasks, holdings, funnel stats, onboarding progress,
workspace activity, and the deal registry. Four attention categories, all
computed client-side:

1. **Due tasks**: open tasks with `dueDate <= localToday()`, overdue tinted
   destructive.
2. **Idle deals**: deals whose stage is in the active group with more than
   `IDLE_DEAL_DAYS = 21` days in stage, most idle first.
3. **Stale marks**: holdings with a positive cost basis, not written off,
   whose last mark is null or older than `STALE_MARK_DAYS = 180`.
4. **FX rates missing**: one destructive row linking `/settings` when the
   rollup excluded holdings for missing rates.

All four empty renders the sunrise zero-state ("go file a memo"). The page
also carries the `GettingStarted` checklist, a portfolio rollup strip, and
the recent-activity feed.

## Trap list (route layer)

- Tokens are enforced in Better Auth database hooks, never in routes
  (`setup.tsx:22-25`, `join.tsx:13-16`). Routes only forward headers.
- Merge redirect on company/deal/person detail pages; holding detail lacks
  it (`companies_.$companyId.tsx:66` and siblings).
- localStorage reads happen post-mount (`deals.tsx:133-140`); SSR must agree
  with the first client paint.
- Sort and filter on visible labels, never ids (`deals.tsx:80-121`).
- Radix `asChild` needs `{...props}` forwarding
  (`portfolio_.$holdingId.tsx:293-305`); dropdown swatches must be menu
  items (`settings.tsx:1101-1104`).
- Existing select options rename, never delete (`settings.tsx:1029-1031`).
- Dates compare lexically as ISO strings (`tasks.tsx:18-22`, `today.tsx:46`).
- The `group` field on the deal stage attribute's options is load-bearing on
  four surfaces: deals list chips, DealBoard, Settings, and Today's
  idle-deal filter.
- Client-side dedupe before `createSpace` (`spaces.tsx:90-99`) protects the
  slug-per-parent unique index.

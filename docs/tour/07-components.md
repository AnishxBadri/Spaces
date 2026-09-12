# Chapter 7 — components

`src/components/` splits into the table engine, the attribute editors, the
note editor, and feature components. Start with the shared contracts; most
component files become quick reads once you hold these.

## Shared contracts

- **The "record" shape.** Companies, people, and deals are one entity
  object shaped three ways. Row types come structurally from server
  functions and always carry `id`, `name`, and
  `values: Record<string, unknown>`, the attribute bag keyed by registry
  slug.
- **`RegistryEntry`** (exported from `value-editor.tsx`, imported
  everywhere): the client's view of one attribute definition
  (slug, name, type, options). It drives table columns, rail fields,
  create-dialog forms, and timeline value rendering.
- **`RefNames`**: the caller-supplied id → display-name map for record and
  actor references. Unresolved ids render as `…`.
- **No react-query.** Data arrives via route loaders; the universal refresh
  idiom is `router.invalidate()` after any mutation. Components that fetch
  on their own (pickers, TasksRail, the palette) hold local state and
  refetch manually.
- **Race protection idioms** recur: a monotonic sequence ref (a slow older
  response must never overwrite a newer query's results) or an `alive`
  flag with cleanup. Debounces: 150ms task-record search, 180ms palette,
  200ms reference pickers, 800ms note autosave.
- **Styling contracts**: `focus-ring` / `focus-ring-inset` replace shadcn's
  translucent ring app-wide (the stock ring sat under 3:1 contrast);
  `.numeric` applies tabular figures and right alignment as one unit;
  money renders through `fmtMoney`, never Intl compact.

## The table engine

**`table/record-table.tsx`** is the one record table; the header comment
explains that three near-identical implementations previously let focus
and sort affordances drift, and consolidation is the fix. It is purely
presentational over a TanStack `Table<T>`: it does not build columns, own
sort state, or know about the registry. In scope: show/hide/resize
columns, single sort, sticky header, sticky first column, row-to-record.
Saved views live one level up in `components/views/` (SPA-14): `view-bar.tsx`
is chips for the saved views plus a filter popover and save/update/delete,
`use-view-state.ts` is the page-side half that applies `?view=` and hands the
bar a snapshot to compare. Deliberately absent from the table itself: bulk
edit, CSV, virtualization.

Column building lives in the routes: fixed identity columns plus one
column per registry attribute whose cell is a `ValueEditor
variant="cell"`, so every attribute is simultaneously a sortable column
and an inline editor. The save path is `updateRecord` then invalidate; on
error, toast and invalidate anyway so the editor snaps back to server
truth. Resizing has keyboard support (arrow keys on the separator, 16px
steps, 64px floor). Sticky cells are opaque on purpose so scrolled-under
columns don't bleed through.

`TableToolbar` carries the filter input, a column-visibility dropdown, and
an `<output>` count; surface-specific chrome (the deals stage chips) rides
in as children on a second row. `AddColumnButton` is just the trigger for
`AttributeCreateDialog`.

**`use-table-prefs.ts`** persists column visibility and sizing to
localStorage per surface. Since views shipped, the split is: a view owns
filter, sort, which columns show and page extra (server-side, shareable);
local prefs own column **widths**, which are about your screen, not the
view. The lazy initializer guards for SSR, and write failures are
swallowed: column widths are not worth an error toast.

**`cells.tsx`**: the four shared cell shapes. `RecordLinkCell` and
`ChipLink` are built with TanStack Router's `createLink` over a plain
anchor, and the stated reason matters: hand-wrapping `<Link>` erases route
inference, and a mistyped route param stops being a compile error. Both
spread `{...props}` onto the anchor; that forwarding must be preserved.

## Attribute editors

**`attribute-create-dialog.tsx`**: the "+ add column / attribute" flow.
User-creatable types exclude record/actor references and status
(system-only). Note the `DialogTrigger asChild` around a caller-provided
trigger: the CLAUDE.md trap site. Pass an element that forwards props or
the dialog silently never opens.

**`value-editor.tsx`** is the typed attribute editor, one implementation
for table cells (`variant="cell"`), record rails (`variant="field"`), and
create modals. `onSave` semantics differ by host and the editor doesn't
care: tables save immediately; create dialogs accumulate into local form
state. The type switch:

- record references → a dropdown with embedded search (scoped to
  `targetKind`, debounced), single or multi chips. The search input stops
  keydown propagation to defeat Radix's typeahead stealing keystrokes.
- actor references → lazy user list on first open.
- select/status/multi-select → option pills colored via
  `optionColor`; multi saves null when emptied.
- rating → a radiogroup of stars; clicking the current value clears.
- date → variant-dependent: cells use a read-mode button that swaps to a
  date input on click (an always-rendered date input would put a US
  mm/dd/yyyy skeleton in every empty row); fields use the native control.
- text-likes → local draft with a committed ref, commit on blur/Enter,
  Escape restores. Number and currency parse with `Number()` here; this is
  the client end of the string-to-number boundary.

`fieldSpanClass` makes the create-dialog grid registry-generated:
everything half-width except `description`, the one long-form field by
convention.

## The editor stack

**`editor/note-editor.tsx`** wraps BlockNote. The schema registers the
custom `mention` inline spec; the glossary extension arrives through
`_tiptapOptions.extensions`. The editor is created once with an empty dep
array: terms are captured at creation, so a term defined while a note is
open highlights on next load, not live. Recreating the editor would
destroy cursor and undo history; that's the tradeoff, documented.

The component never saves. `onChange` hands the route the document and a
markdown export; the route's autosave (chapter 6) builds
`{bodyJson, bodyMd: deriveMarkdown(...), mentionIds: extractMentionIds(...)}`.
`extractMentionIds` walks the doc collecting mention entity ids (these
become backlinks via the server's diff-sync). `deriveMarkdown` re-appends
mentions as a `Mentions: [[Label|entity:id]]` trailer because BlockNote's
markdown export drops custom inline content; bodyMd stays greppable even
if not positionally faithful.

**`editor/mention.tsx`**: the mention chip spec. `entityId` is
authoritative; `label` is a cached display string, so a rename elsewhere
leaves stale labels while the link still resolves. It renders a plain
anchor (not a router Link) because it lives inside BlockNote's tree.
Mentions never create entities; they only reference ones surfaced by
`searchEntities`.

**`editor/glossary-decoration.ts`**: why decorations and not content. The
note JSON is authoritative; if term highlights were inline nodes, renaming
or deleting a definition would mean editing every stored note, which is
derived data living inside the source of truth. ProseMirror decorations are
presentation-only, recomputed at render, and vanish when a term does. The
plugin rebuilds decorations only when `tr.docChanged` (selection
transactions fire constantly; rescanning per caret step makes an editor
feel heavy), matches per text node so position math stays trivial (a term
never spans a node boundary), and delivers the definition via the native
`title` tooltip: no portal, no positioning, no state in the editor view.

## Feature components

**`app-sidebar.tsx`**: nav rail, used twice (desktop rail, mobile drawer).
`NAV_ITEMS` puts Today first (the attention page is the notification
channel in a self-hosted product) and is reused by the palette's "Go to"
group. The user menu styles `DropdownMenuTrigger` directly without
asChild, one of the two sanctioned ways around the forwarding trap.

**`command-palette.tsx`**: mounted once in the shell, toggled by Cmd-K.
The load-bearing choice is `shouldFilter={false}` on cmdk: results are
ranked server-side in Postgres, and cmdk's client re-filter would drop the
typo matches trigram search exists to catch. Document hits navigate to
their parent record (documents have no page). Snippets are highlighted by
splitting on the `«»` guillemets ts_headline was configured to emit, so
extracted deck text is never handed to an HTML parser.

**`deal-board.tsx`**: the kanban. Columns are not derived here; the deals
route passes the stage attribute's options in. Drag is native (no
library): cards set a custom MIME entry on dragStart; columns
preventDefault on dragOver and read it on drop. The card body is a router
Link, so click navigates and drag moves. Moves are optimistic via a
`moved` overlay map consulted before server truth; commit writes the
overlay, calls `updateRecord({patch: {stage}})`, invalidates; failure
deletes the overlay entry (the card snaps back). Because a drop is exactly
a stage write through `updateRecord`, the attribute-event log, the
invested→holding hook, and stage analytics all fire identically to a table
edit. Drops onto `passed`/`lost` (hardcoded option ids, a known coupling)
pause in a `CloseReasonDialog` whose copy differs for "your no" vs "their
no"; skipping is allowed and commits the move without a reason.

**`record-timeline.tsx`**: renders the server-condensed timeline
(chapter 4): macros through a verb-label map, interactions as tinted rows
with attendee chips, and attribute bursts as a collapsed "changed N
attributes" row that expands to a definition list. Values resolve through
the registry (option labels, reference names); only the new value is
shown, no before/after diff.

**`tasks-rail.tsx`** (company and deal pages only; people don't have it):
self-contained fetch of the entity's open tasks, deliberately not a loader
dependency. The checkbox always renders unchecked because completing
removes the row. Overdue is a lexical ISO comparison against
`localToday()`.

**`task-composer.tsx`**: the create dialog (one content line, three
pills, "create more" keeps it open). Closing resets everything except a
re-seeded preset entity: a chip linked in an abandoned draft must never
leak into the next task. The due pill runs `parseDue` live per keystroke
with a feedback line, quick chips computed by the same parser, and a
native date input fallback. The pill buttons carry `type="button"`;
without it, Radix's trigger button would submit the form.

**`record-files.tsx`**: the files tab and the client half of the upload
pipeline. Per file: size checks, in-browser sha256 via `crypto.subtle`
(with a guarded secure-context error), `prepareDocumentUpload` (no URL
returned means the blob already exists and the PUT is skipped), direct
fetch PUT with the returned headers verbatim (the S3 signature breaks
without them), `finalizeDocumentUpload` with a guessed kind, invalidate.
While any document is `pending`, it polls by re-invalidating every 2.5s
with a hard cap of 10 attempts: an infinite poll on a broken worker is
worse than a stale row.

**`document-preview.tsx`**: preview modal. The security invariant repeats
from chapter 5: downloads stay octet-stream attachments; the preview
fetches the same opaque bytes and renders them itself. SVG is deliberately
excluded from previewable images (script vector); the blob type used for
object URLs "is ours, not the upload's — that is the whole safety
property". PDF rendering dynamic-imports `unpdf/pdfjs` inside the dialog
only, renders on the main thread (no worker asset to serve), caches the
parsed doc across page turns. Spreadsheets re-parse the worker's
tab-separated text back into tables, and numeric-looking cells get
`.numeric`: the tabular rule holds inside previews.

**`space-glossary.tsx`**: term CRUD on the space page (not settings,
because the payoff, auto-linking in filed notes, lives there). Global
terms show a "global" pill so editing one from a space page doesn't look
space-local. Aliases are a comma-separated input on purpose: a tag input
is more chrome than the job needs.

**`templates.tsx`**: `TemplatePicker` fetches lazily on
pointer-down/focus of the trigger (data loads before the menu opens) and
stable-sorts templates whose `suggestOn` includes the current context to
the top: ordering, not automation; nothing auto-creates. Applying a record
template merges into form state with user-entered values winning.
`SaveAsTemplateAction` is the by-example capture flow; its dialog copy
states the capture semantics per kind, and future edits never touch what
was captured.

**`getting-started.tsx`**: the onboarding checklist. Steps are computed
server-side from real artifacts and can never disagree with the data;
dismissal is localStorage, guidance not state, and is read post-mount so
SSR and client render identically.

**`log-interaction-dialog.tsx`**: the manual meeting/call log, pre-seeded
with the record it opened from. Google Calendar, when it lands, automates
rows into exactly this shape.

**`empty-state.tsx`**, **`wordmark.tsx`**, **`password-input.tsx`**: the
teaching empty state (two sentences plus the create action), the logo
block, and a reveal-toggle password input ("reveal is a convenience for
typing, not a storage decision").

## `ui/` primitives

Modern shadcn function components. The systematic deviation, documented in
button.tsx and input.tsx: the stock translucent focus ring is replaced by
the app's `focus-ring` utility, and the comment says to keep the swap if
the primitives are ever re-vendored. `command.tsx` forwards
`shouldFilter` (the palette's server-ranking hook). The rest are stock
with tuned animation timings.

## Trap list (component layer)

- Radix `asChild` requires prop forwarding. Working patterns in the tree:
  pass a plain button/Button (native prop spread), style the trigger
  directly without asChild, or wrap in a click-handling span
  (`SaveAsTemplateAction`, at the cost of focusability).
- Hydration-safe localStorage: read in a guarded lazy initializer
  (`useTablePrefs`) or post-mount effect (`GettingStarted`, deals view
  toggle). Never read during SSR-visible render.
- `NoteEditor` must stay inside `ClientOnly`; it's SSR-unsafe.
- `focus-ring-inset` inside table cells because an offset ring gets
  clipped by the scroll container.
- Board close-stage ids `passed`/`lost` are hardcoded; renaming those
  option ids would break close-reason capture.
- Chrome MCP note from CLAUDE.md applies to every dialog here: synthetic
  clicks don't open Radix dialogs; use `element.click()` via the
  JavaScript tool when driving the app.

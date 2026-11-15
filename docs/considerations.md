# Considerations

Floating thoughts, not on the roadmap and not decided. Each is a few lines:
the idea, what exists today, what it could become. Promote one to a decision
or a slice when it earns it; delete it when it stops being interesting.

## An Emails page — 2026-10-18

Every CRM has one; we have email only on records.

- **Shape:** a threads list across all records — Mine / Team, plus a filter
  for threads that matched no record. The same `ThreadRow` rows and email
  window as the record's Interactions tab; nothing new to design beyond the
  page.
- Answers "what came in this week" without opening each record.
- **Place:** sidebar Library — Notes · Emails · Meetings · Files · Feeds;
  shortcut `G I` (`G E` is Meetings, `G M` Mandate).

## Decision traces (context graphs) — 2026-10-16

A context graph in the newer sense stores _why_ a decision was made, not only
_what_ is true, so past judgment becomes precedent people and agents can query.

- **Have:** the graph (`link`, `ENTITY_REFS`), provenance and time
  (`attribute_event` with its source), the context assembler, and judgment
  memory — the `SimilarLane` pulling other deals' close reasons, off by
  default (D58). Stage changes, close reasons and suggestion accept/dismiss
  are already partial traces.
- **Missing:** the why of a stage move or a dismissal, mandate exceptions
  ("outside check size, but we know the founder"), group input, and precedent
  as an everyday question.
- **Could be, small to large:** an optional one-line why on stage moves and
  dismissals, stored on the existing event · a mandate-exception flag · judgment
  memory on by default for deal questions, shown on the deal ("similar: 2
  passed, 1 invested") · later, joining old passes with what those companies
  did next, to learn whether the call was right.
- No graph database needed; the gap is capture, not architecture.

## Feeds, after the built-in — 2026-10-16

Feeds are decided (D87), the reader pane included. Two ideas are not.

- **The reader as a window elsewhere:** a headline in a space's What's moving
  opens the same reader as a window instead of the publisher's site.
- **A keyword filter per tag:** a feed tagged to several spaces sends every
  headline to each. Start by tagging general sources narrowly; add a filter if
  the noise bites.

## From the Taghash comparison — 2026-10-18

Their screens against ours. None changes core logic: records, the one write
path, the graph, provenance and Ask stay as they are; each is an addition.

- **Role on the person–company link** — Founder, Advisor, Investor, Board
  member, Ex-founder, Ex-employee, custom. The role belongs on the link, not
  the person. The only one that touches the model (attributes on a
  relationship), still additive.
- **Team members who know this person** — whose mailbox the interactions came
  from, shown on a person: the warm-intro question. The data exists.
- **Side-panel record from a list**, "1 of 214", ↑ ↓ to the next — for
  triaging new deals without losing the list.
- **Confirm an auto-matched enrichment** — "12 fields from a matched profile ·
  Confirm / Change source" when the match was a guess.
- **Quick filters by teammate** — My deals plus one chip per member.
- **Restrict who can add options** to a select — stops duplicate and junk
  options (their Source has "VC" twice; Champion has "a").
- **Deal memo template** — investment requested, problem, solution, use of
  funds, competition, TAM — filled by AI from the deck, not nine empty fields.
- **A source badge on a field at rest** ("via Apollo"); provenance is stored
  already.
- **Competitors and Investors** as default company relationships.
- **Richer tasks** — a description and subtasks at least; priority optional.
- **One analytics page** — funnel by stage, ageing per deal, source mix; the
  data is in `lib/deals/funnel.ts`.

Already ahead: rounds as separate deals, 13 field types, entity resolution
(they file people under "hotmail"), Files and Drive, grounded AI, labelled
actions, Owner as a real person (their Champion is typed first names).

## A decision lane (TypeSafe Jev) — 2026-10-18

Jev (TypeSafe AI, early access since 15 Sep 2026) returns a choice, a score
or a yes/no with a confidence — typed decisions, not prose. Vendor-reported:
~70–500 ms, very cheap. Not for holistic reasoning; Ask keeps that.

- **Fits our binary calls:** mandate fit (score + inside/outside — today only
  stage is checked), feed headline relevant to a tagged space (the
  Inc42 → Aerospace noise, without keyword lists), email noise and which
  record it belongs to, duplicate pair same-or-not with a confidence that
  decides auto-merge vs Review, which space a new company files into.
- **Shape:** a new "decision" lane in Settings › Models, any provider that
  answers typed questions (Jev first), under the same sensitivity floor —
  it is a cloud API, so sensitive records never reach it.
- Sources: nexos.ai/blog/what-is-jev, theregister.com/a/5296711.

## Mirror root — 2026-10-24

Cancelled as a slice (`SPA-297`, `storage-15`): one workspace binding under which every upload projects to `Space / Company / Deal / Kind / file`.

- **Why not:** relations live in the app; Drive and Box are not a projection of the graph. A mirror root imposes the app's tree on a drive the user may already organise their own way.
- **What exists:** the bound folder per record with write-through — upload into Spaces, the file lands in the folder the user chose; `storage_binding.is_mirror_root` and its unique index are in the schema, unused.
- **Could be:** an opt-in export of the tree, if a user asks; the projection body in the cancelled issue is the spec.

## Banked compositions — 2026-10-25

Features made of primitives that already exist, so nobody has to build them, only wire them. Revisit each when someone asks.

- **Pass-letter drafting** — a draft note to the founder from the deal's `close_reason` and its assembled context, proposed as a note on the deal. One more prompt on the summarize lane; nothing is ever sent to the founder.
- **Monday digest** — a weekly roll-up of what changed, what is waiting, and feed items that matched no record (sourcing signal). One scheduled job and one template, sent only when `SMTP_URL` is set; Today stays the notification.
- **Deal scorecards** — weighted per-partner votes rolled into a score. Needs one value per member rather than per record, so it waits on a second partner asking, and on multi-workspace membership to hold a partner's weight.

## Ask: slash commands and branching — 2026-11-08

Drawn on the Ask sheet (board 10, panels 3 and 6) and parked.

- **Slash commands:** `/` in the composer as a shortcut to actions that
  already exist, never a new capability. First five if it lands: `/prep`,
  `/find`, `/summarize`, `/watch`, `/note`. `/enrich`, `/task` and `/file`
  stay out because Ask already proposes them as cards. `/memo` waits for
  an AI-drafted memo, which does not exist yet.
- **Branching:** editing a past question re-asks from that point as a
  branch, and the original thread stays whole. The cheap form is "Ask again
  in a new thread from here", which copies the turns so far into a fresh
  thread and needs no tree in the UI.
- Editing the **last** question (↑ in an empty composer) is not parked: it
  stays in the Ask set.

## Panes that scroll, not the page — 2026-11-11

The window scrolls today and the head folds into a 48px bar; only the
record's rail scrolls on its own.

- **Shape:** the head and the tabs stay put and the body under them scrolls,
  one scroller per pane and never one inside another. Records and a space
  (rail and tab body as two panes), lists (the table scrolls both ways, so
  its horizontal bar is always in reach), the deal board (each column),
  Tasks, Review, Notes, Settings (the Save bar pins to the pane foot), Ask.
- **Stays a page:** Today, a note, a holding, Portfolio, Import, and every
  page on a phone.
- **Costs:** the full head stays on screen; every sticky offset is
  re-anchored; Back must restore a pane's scroll by hand; the body pane has
  to take focus for Space and Page Down; panes need
  `overscroll-behavior: contain`. It reverses the sticky-head verdict of
  2026-10-08, and most of `head-fold.tsx` goes on desktop.
- **First step, free of all that:** thin rule-coloured scrollbars with a
  reserved gutter.

## Fewer settings pages — 2026-11-11

Sixteen pages in four groups, and one provider can sit on four of them
(Google: Connections, Email & calendar, Files, Meeting notes).

- Folding Search into Models and Email forwarding into Email & calendar
  makes fourteen. It reopens the settings map (D81), so it waits for the
  owner to ask.

## Direct MCP writes for low-stakes things — 2026-11-15

Today an MCP token only proposes (`propose_suggestion`, `propose_card`); even
a task waits in Review. Attio's MCP writes as the user and leaves the
confirmation to the client's tool prompt.

- **The ladder:** write directly where a mistake is cheap and additive; keep
  proposals where it changes a value, money, identity or filing.
  - **Direct:** tasks, notes, comments, then people and companies with
    guards.
  - **Proposal:** deals (the funnel is judgment), attribute values, filing,
    merges, portfolio events.
- **Guards on a record create:** people and companies only, through
  `resolveEntity` with a domain or email required (no name-only births, so
  dedupe works); a silent birth, so no enrichment or plugin job spends credits
  until a person touches it; a per-token daily cap, so an injected page cannot
  flood the graph; `source_class: integration` so agent births are filterable.
- **Why not all of Attio's set:** client confirmation is soft ("always allow",
  headless agents), the content agents read is adversarial (founders' decks),
  merge has no unmerge, and portfolio history is append-only.
- **Precedent to square:** a space watch's find is an `add_record` proposal,
  not a birth.

## Smaller open questions

- **`object.kind`:** one column naming "what machinery" an object has, so the
  code-only link between a core entity kind and its object row becomes
  structural and promoting a custom object is an `UPDATE`. Cheap now, painful
  after the first promotion.
- **A plugin asking for a custom object by shape:** created as an ordinary
  user-owned object on enable, so plugin data is visible in the graph without
  plugin UI (Twenty does this).
- **A comparison page for launch** (against Twenty, Attio and the vertical
  tools), on an honest-claims rule: never claim a storage advantage (Twenty
  has the same local-default answer); claim the research half, two-container
  ops, BYOK down to Ollama, the investor schema and the financial engine.
- **A funding-status and runway lens** over the portfolio, as the first
  consumer if founder metrics (MIS) ever land.

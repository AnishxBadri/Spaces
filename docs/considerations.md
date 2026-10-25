# Considerations

Floating thoughts, not on the roadmap and not decided. Each is a few lines:
the idea, what exists today, what it could become. Promote one to a decision
or a slice when it earns it; delete it when it stops being interesting.

## An Emails page — 2026-10-18

Every CRM has one; we have email only on records.

- **Shape:** a threads list across all records — Mine / Team, plus a filter
  for threads that matched no record. Same one-row-per-thread rows and the
  same thread viewer as the record's Interactions tab; nothing new to design
  beyond the page.
- **Threads first, everywhere:** the record list and the viewer group by
  `thread_id` (already stored and indexed) — one row per thread, the whole
  thread in the window, earlier messages folded. Drawn on Record 05 and
  Windows 02; not built.
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

## Feeds, built in — 2026-10-16

RSS today is `plugins/rss`: one install per feed, a pasted record id, items
as signals on that record.

- **Leaning:** built in, not a plugin — no key, no account, no credits (the
  D76 Website-source reasoning), and a plugin cannot draw the page this needs.
- **Shape (owner):** a Feeds page in the Library group; paste a URL, the
  worker fetches every 30 minutes; a feed is tagged to spaces and its
  headlines show in their What's moving; a feed is just another watch in the
  space's Watching lane. Workspace-wide, no read state, plain headlines (no
  company matching). Today shows one line at most.
- Drawn on the canvas: Lists page, `09 Feeds · proposed`.
- A feed tagged to several spaces sends every headline to each; start by
  tagging general sources narrowly, add a keyword filter per tag later if the
  noise bites. Shortcut `G R`; a failing source's Fix › reopens its window.
- Feeds carry more than headlines: a summary per item (the plugin already
  reads it), a source logo (RSS `<image>`, Atom `<icon>`/`<logo>`, else the
  site's favicon) and often an item image (`media:thumbnail`, an image
  enclosure, or the first `<img>`). Fetch and store images in the worker —
  never hotlink, so reading never pings the publisher.
- Rows: logo + headline + one summary line (variant A, owner 10-16); no
  thumbnail in the row. The fuller blurb belongs in a reader (proposed: a
  pane on the Feeds page, the same reader as a window elsewhere).

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

## Banked compositions — 2026-10-25

Features made of primitives that already exist, so nobody has to build them, only wire them. Revisit each when someone asks.

- **Pass-letter drafting** — a draft note to the founder from the deal's `close_reason` and its assembled context, proposed as a note on the deal. One more prompt on the summarize lane; nothing is ever sent to the founder.
- **Monday digest** — a weekly roll-up of what changed, what is waiting, and feed items that matched no record (sourcing signal). One scheduled job and one template, sent only when `SMTP_URL` is set; Today stays the notification.
- **Deal scorecards** — weighted per-partner votes rolled into a score. Needs one value per member rather than per record, so it waits on a second partner asking, and on multi-workspace membership to hold a partner's weight.

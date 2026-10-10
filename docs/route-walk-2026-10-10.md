# Route walk 2026-10-10 — deviations against the sheets (main `c28fae4`)

How it ran: `@spaces/web` built at `c28fae4`, booted twice by the e2e screenshot harness against a throwaway `spaces_e2e_<pid>_shots` database seeded with the bench, viewport 1440×900, every `_app` and settings route top and scrolled, compared against the Paper sheets (Surfaces O1–O4, Shell p-J-0, Spaces p-I-0, Settings p-M-0, Today p-O-0, Cmd-K p-H-0, Enrichment p-L-0, Files p-F-0) and `docs/design-contract.md`. The 146 screenshots live outside the repo. Entry ids (R1, S3, X1…) are what the UI sweep issues in Linear cite.

Each entry gives: route · sheet · what the app shows · what the sheet or contract says · **class** · likely file. Differences that come only from seed data are left out. `unconfirmed-sheet` marks comparisons against p-F-0 (Files).

---

## 1. Record pages (company / person / deal / custom)

All four are the stacked body. The D74 anatomy has not been ported to any of them. **Confirmed.**

### Shared (all four record routes)

- R1 · O1–O4 (B-0) · `RecordBody` is a 2-column property grid (CAPS labels, about 784px wide) above stacked sections, with a separate bone rail on the right (x 1080–1440). · Sheet: a 320px details column on bone on the left (single label–value rows with lowercase mono labels, then the relationship sections), and a 44px bone tab head on the right: Notes · Interactions · Files · History, each with a mono count, Notes as the default, last tab remembered. · **port** · `routes/_app/companies_.$companyId.tsx`, `people_.$personId.tsx`, `deals_.$dealId.tsx`, `o_.$objectSlug.$recordId.tsx`, `components/record/record-parts.tsx`
- R2 · O1–O4 · Every attribute is shown, empty ones as `—` (company: Founders —; person: Description, Twitter, Phone —; deal: Referred by, Close reason —). · Sheet: empty attributes fold under `Show all · n empty` (D69). · **port** · `PropertyGrid`
- R3 · O1–O4 · The body ends in sections the sheet doesn't have: a **Context** section (`Context … show ›`, company--full.png). · D74: there is no Context tab or section; Ask's answer card carries Sources. · **port** · company route
- R4 · O1–O4 · The relationship sections sit in a right-hand rail (Deals with a pine `+ New`, Spaces with a `+ Tag into space…` select, People, Tasks), each titled in sentence case at the title step. · Sheet: they sit in the details column under the grid: Waiting, Team / Companies, Associated deals, Spaces, Tasks, each with a mono count and an `+ Add …` composer row. · **port** · `RailSection` callers
- R5 · O1, Shell 03-B · The folded sticky head (company--scrolled.png) is 40px: stamp `COMPANY A113E614` + name + the head controls, and no tabs are pinned under it. · Sheet: a 52px fold with a short `COMPANY` stamp, the name, `10-04 · 1d · next 10-09` in mono, two actions, and the tabs pinned underneath. · **port** · `HeadBar` in `page-header.tsx` / `RecordHeader`
- R6 · O1–O4 · The crumb prints the short id and a slug: `COMPANIES / A113E614 / VAYUORBITAL…`, `PEOPLE / 6E597999 / ISHAAN@VAYUORBITAL.COM`. The stamp repeats the id (`COMPANY A113E614`). · Sheet: `COMPANIES / C-0231 / ADDED 2025-08-14`, plus a domain (or `CEO · Flent`) in mono beside the name. · **nit** · `RecordHeader`
- R7 · O1–O4 · Interactions rows end on a pine sans `Write up` link inline after the title. There are no kind filters, no `Has attachments`, and no `n of N · more ›` foot. · Sheet E1/O1: kind filters All · Email · Meeting · Call on a second row, and an end lane (`accepted`, `via Anish · ⧉ 2`). · **port** · company route, interaction list
- R8 · S1 (B-0), p-F-0 01 · The Files section shows `upload` in the head, a row whose second line is the extracted-text snippet, per-row icon buttons (filing, download, preview, delete), then `…or paste a Drive link` plus a button labelled `Picker not set up`. · Sheet: one add row `+ Drop files, or paste a Drive link… [Attach from Drive][Upload][···]`, rows grouped by kind (`DECK · 2`), an end lane `4.1 MB · 09-02`, and `···` per row. · **port, unconfirmed-sheet** · record files section
- R9 · contract §1 "Commentary" · The button label `Picker not set up` is a state worded as a control. · State belongs in the mono meta, not on a button. · **nit** · record files section
- R10 · O1 · The head carries `Enrich needs a model · Add a model ›`. · D80: "Enrich works with the free Website source and shows More sources ›". p-L-0 00: an outlined `Enrich` button followed by `Website, then Apollo · ~1 credit`. · **bug** (contradicts D80) · company route / enrich head line
- R11 · contract §1 Commentary · The company's Notes head prints `0 filed · 2 mentions` and the link `note about this ›`. There is no composer row in the section. · Sheet O2: a `+ Write a note… N` composer row as the first row. · **nit** · record notes section

### Company `/companies/$id` (company.png, company--full.png)

- R12 · O1 · The head has a Sensitive switch, the enrich line, `Log interaction L`, `Note about this` (no key), and a ghost `Save as template`: five controls. · Sheet: `Log interaction L`, `Write email E`. · **nit** (email is project 25) · company route
- R13 · O1 · `Founded 2019` and `Team size 4` are right-aligned at the far edge of a text cell. Every other value is left-aligned. · Sheet: left-aligned in the value lane. · **nit** · `PropertyCell` for number
- R14 · contract (dialog) · Opening an attribute from the record grid gives the head `Edit Description · on companys`. The settings path says `on Companies`. · **bug** · `components/attributes/attribute-dialog.tsx:774` (`${objectLabel}s` fallback; `rail-field.tsx` doesn't pass `objectPlural`)

### Person `/people/$id` (person.png)

- R15 · O2 · The rail holds only `Spaces 0 + Tag into space…`. `Deals via People · 1` is a stacked body section, and Companies is a grid cell. · Sheet: a Companies section (with role), Deals, Waiting, Spaces and Tasks in the details column. · **port**
- R16 · O2 · The grid shows `NAME` as its own row. SPA-243's `first_name` and `last_name` don't appear. · Sheet: name parts, `email … +2`, phone in E.164. · **nit**

### Deal `/deals/$id` (deal.png)

- R17 · contract §3 "A record" ("actions with key hints — all outlined, a record head has no single affirmative to give pine to") · The head's `Move stage M` is a **filled pine** button. · Sheet O3: `Move stage M` is outlined. · **bug** · `deals_.$dealId.tsx`
- R18 · O3 · There are 4 readouts (Our check, Close `—`, Days in stage `665 · med 600`, Last contact). · Sheet: 5, including `Round` (`$4.2M @ $18M`). · **port**
- R19 · contract §2 "Pickers and dates" · The property grid's Close date shows the native `mm/dd/yyyy` skeleton plus a calendar glyph in an empty cell. · Contract: a date in a cell reads as ISO text until clicked (`DateCellEditor`). · **bug** · property grid date cell
- R20 · O3 · The Pipeline stepper is in the right rail. History has no filter row. · Sheet: Pipeline sits in the details column with `Diligence 11d · med 9`. History has All · Stage · Attributes · Ledger filters and voided rows struck through. · **port**
- R21 · O3 · The head adds `Task T`. · Sheet: `Log interaction L`, `Move stage M`. · **nit**

### Custom object `/o/vehicles/$id` (o-vehicle-record.png)

- R22 · O4 · The head has only `Note about this`. There is no `Log interaction L` and no `Task T`. Interactions reads `None logged.` with no composer row, so a custom record can't log an interaction from its own page. · Sheet: `Log interaction L`, `Task T`. · **port**
- R23 · O4 · The rail shows `Referenced by 0 · No record points here yet.` · Sheet: relationship sections (Portfolio, Co-invested deals, Partners, Spaces, Tasks). · **port**
- R24 · O4, contract §1 · The Files section has a dashed dropzone (`Drop files, or click / files or a link`), then the Drive paste row, then `Picker not set up`, all stacked. · Sheet: `4 · 31 MB` with `Link from Drive` and `Upload` in the head, and a dropzone only as the last row. · **port, unconfirmed-sheet**

### Holding `/portfolio/$id` and term `/terms/$id` (holding.png, term.png)

- R25 · contract §1 Commentary · The holding rail reads `Ownership: Cost basis only — unconverted instrument, a percentage would be a guess.` · An explanation sentence in a rail. · **nit**
- R26 · contract §1 ("An empty section is one short line … never instructs"), P5 · The term page's empty state is `Nothing mentions this term yet.` followed by `A term gathers what mentions it and holds nothing itself — file notes and decks into a space.` (doctrine), with no primary. The rail reads `No company yet — none of the mentions is filed on or names one.` · **nit** · `terms.$termId.tsx`

---

## 2. Settings (per page)

Chassis-wide, on every settings page:

- S1 · owner decision (no `esc` printed) · The nav head reads `‹ Settings   esc`. · **bug** (owner rule; sheet M-00 drew it, the rule wins) · `components/settings/settings-chassis.tsx:110`
- S2 · M-01…08 · The head is a CAPS mono eyebrow (`SETTINGS · WORKSPACE`), a serif title, a **sans sentence** (`Who can open this workspace…`, `The OAuth clients members connect their accounts through.`, and so on), then a single hairline. · Sheet: a sentence-case mono eyebrow (`Settings · Workspace`), the title, a **double rule**, and no blurb. (Contract §3 still says CAPS eyebrow + hairline; D81/2026-10-08 "page blurbs go too".) · **port** · `settings-section.tsx`
- S3 · owner decision (group heads) · Groups inside a page are **44px bone bands** with sentence-case titles (`Accounts`, `Providers`, `Rates`, `Mailbox`, `Runs`). · Owner/sheets: mono caps labels on a hairline (`IDENTITY`, `PROVIDERS`, `RATES`), no band. · **port** · `SectionHead` usage in settings sections
- S4 · owner decision (content ~700px) · The content column is `max-w-[56.25rem]`, which measures **900px** (836px inside the gutters). · Sheet: about 702px. · **port** · `settings-section.tsx` / chassis
- S5 · D81 "No footer caption strips / hint by cost" · Almost every field carries an invariant grey hint ("Stored encrypted as the workspace key.", "Host and port, as the provider lists them.", "Minutes between polls, 1 to 60.", "Optional. One per line, Name: value…"). · Sheet: a hint only where cost or privacy is at stake (`Not your account password.`). · **bug** (commentary rule) · each section component
- S6 · D81 Save bar · Correct: hidden (`aria-hidden`, `inert`, top=912 offscreen) while clean, and shown as `2 changes · Discard · Save ⌘↵` once dirty (v2-connection-apps-dirty.png). No deviation.

### General (settings-settings.png, v2-settings-general-top.png)

- S7 · M-01 · The order is **Name, then Logo**. · Sheet: Logo (with `Upload` and **`Remove`**) before Name. There is no `Remove`. · **port** · `routes/_app/settings/general.tsx`
- S8 · M-01 · No `IDENTITY` or `DEFAULTS` caps labels; the three rows sit straight under the head rule. · **port**
- S9 · M-01, owner · Base currency has the hint `Changing it re-prices the portfolio strip; ledgers keep their original currency.` and is a free text input `USD`. · Sheet: no hint, and a `Select` reading `USD · US dollar`. · **port**
- S10 · owner · `What's set up 1 of 7` is a **44px bone band** (measured 44, `rgb(244,243,239)`), with each item's one-line description underneath. · Owner: no bone band. (D80 keeps the list itself.) · **port**
- S11 · Controls sit right-aligned at the row end (Name input x 864–1088). · Sheet: controls in a left-aligned lane at about 234px from the label. · **nit**

### Members (settings-members.png, settings-members-invite.png)

- S12 · M-02 · Roles are static mono tags (`admin`, `member` boxed). There is no role `Select`, no per-row `···` (Make admin / Suspend access…), no `PEOPLE 4` ledger with Person/Role heads, and no `WAITING TO JOIN` section. A created invite is a bone row holding the raw URL plus `open link · member · expires 2026-10-17   revoke`. · **port** · `settings/members.tsx`
- S13 · M-02 · Invite is an inline form row (email, role, pine `+ Create invite`) with the hint `Single-use link, valid 7 days. Leave email empty…`. · Sheet: a pine `Invite` in the head. · **port**

### Templates (settings-templates.png)

- S14 · M-02 · Rows carry `company person deal space` toggle chips and an `archive` text link. · Sheet: `TEMPLATES 5` with Template / Kind / Offered first on columns, chips plus a dashed `+`, `···` per row, and an `ARCHIVED` section with Restore. · **port**

### Models (settings-models.png, settings-models--scrolled.png)

- S15 · M-03 · Sensitivity is a `Select` (Normal). · Sheet: radios, each with one line (`Any routed model may read it.`, `Only local models read it, and no plugin sees it.`). The floor control is at the top, as D81 asks. · **nit**
- S16 · M-03 · The providers table lists all 5 with a `Test` button each, even when unset. Below it, **every** provider's key, Base URL and Extra headers fields are always expanded (15 rows). · Sheet: unset providers show `Set up`; one provider opens in place via `Edit`, with Test, Save and the error inline. · **port** · `settings/models.tsx`
- S17 · M-03 · The routing head carries a 2-line doctrine paragraph (`A lane with no model routed hides the features… Records and spaces are marked sensitive on their own pages, not here.`). The lanes are `Extract / Classify / Synthesize / Vision / Research`, each with a description line. · Sheet: `WHO DOES WHAT 7 of 10 set` with jobs named `Read documents extract` and no descriptions. · **nit** (Embed row correctly gone: `Embeddings · none · set in Search ›`)

### Search (settings-search.png)

- S18 · D81 "Search reuses the Models key" · Search asks for its own `OpenAI embedding key — Stored encrypted as the workspace embedding key, apart from any provider key.` · Sheet/D81: `☑ Use the OpenAI key from Models`, with "Use a different key" to override. · **port** (decided, not built)
- S19 · M-04 · The model pick uses **checkbox squares** for a single-choice pin. · Sheet: radios. There is no readout strip (`92% · 106 waiting · Local`), no `SENSITIVE RECORDS` lane, and no `CATCH UP`. · **port / nit**

### Usage & limits (settings-usage.png)

- S20 · M-04 · The page prints **two page heads**: `SETTINGS · AI / Usage & limits` and, mid-page, `SETTINGS · AI / Caps`, each with its own blurb and hairline. · Sheet: one head, a readout strip (Tokens today, Runs today, Waiting in Review), `LIMITS`, `RUNS`. · **port** · `settings/usage.tsx` (stacks two `SettingsSection`s)
- S21 · contract §1 (empty section never instructs) · The empty Runs line reads `No runs yet. Read a deck, summarize a document or suggest spaces, and each shows here as one run.`, and the empty Calls line reads `None — every call so far was a step of a run.` · **nit**

### Objects and one object's attributes (settings-objects*.png, v2-settings-attribute-window.png)

- S22 · M-06 · The Objects index isn't split into `BUILT IN` / `YOURS` / `ARCHIVED` sections, and there's no Restore. · **port**
- S23 · M-06 · On `/settings/objects/companies`, types print as raw slugs (`multi_select`, `record_reference`, `url`). Options are badge rows under the attribute. ORIGIN shows `SYSTEM`/`CUSTOM` badges. Each row has 4 icon buttons (↑ ↓ ✎ archive). The foot caption reads `10 live · drag ⋮⋮ or ↑↓ to reorder`. `AI attributes` lists every attribute as `off Configure`. · Sheet: human types (`Multi-select · 6`, `Record · People`), a Rules lane (`identity · unique`, `filled by Apollo`), `···` per row, `9 · drag to reorder` in the head, and `AI ANSWERS` listing only the configured ones. · **port**; foot caption **bug** (D81 no caption strips) · `components/attributes/registry-list.tsx`
- S24 · owner (dialog head) · The attribute window head is `Edit Description · on Companies` with **`esc`** at the right (sr-only "ape — close"), and `Cancel` + `Save ⌘↵` in the foot. Fill from is present (D76). · **bug** (esc) · `components/ui/dialog.tsx:77-83`

### Plugins (settings-plugins.png)

- S25 · M-07 · `Installed 0` and `Available 0 · signed by the project` are bone bands. `Available` isn't grouped by job and has no tabs. There's a 64px blank under the empty Installed line. · **port** (the registry was empty in the harness, so only the frame could be compared)

### Enrichment (settings-enrichment.png)

- S26 · contract §1 "A readout" (number in mono 22 above a sentence-case label) · Readouts are a **CAPS label on top** (`FIELDS FILLED · 7 DAYS`) with the number under it at 20px. · Sheet p-L-0 01: number above, `Fields filled · 7 days` under it in sentence case. · **bug** · `components/settings/enrichment-section.tsx`
- S27 · D80 · The built-in Website source row reads `needs a model ›`. · D80: "The Website source reads a site's own description, logo and links without AI." · **bug** (or the decision needs amending)
- S28 · p-L-0 01 · There's no membership switch on the source row (sheet: a switch per source). The auto-enrich group is replaced by the sentence `The Website enriches every new record. Add a source to choose more.` Re-use has an invariant hint. What-fills-what uses a bone band plus a segmented Companies/People control (sheet: caps label plus `Companies ▾`). `Recent runs` exists. · **nit**

### Email forwarding (settings-email-forwarding.png)

- S29 · M-07 · There's no readout strip (sheet: Address · Since last check · Threads today). Every field has a hint. Labels read `IMAP server`, `Poll every`, `TLS` (sheet: `Mail server`, `Check every`, `Secure`). `Test connection` sits on a row of its own. · **port**

### Email & calendar / Files / Meeting notes (settings-email-calendar.png, v2-settings-*-configured.png)

- S30 · M-05 · Accounts is a bone band without a count. The Google row reads `Google Mail · Calendar   Not available yet`. · Sheet: `ACCOUNTS 2`, rows with `default`, `in sync`, `Options ›`, and `Connect Google`. D81: a missing plugin shows `Install ›` to an admin. · **port**. `Not available yet` persists even after a Google OAuth client is saved in Connection apps, because the google plugin isn't installed and the registry is empty.
- S31 · known bug "action column clipped at the right edge" · **Not reproduced.** No Connect, Options or Reconnect button renders without the google plugin installed, so no action column exists to clip. `/settings/connections` 301s to `/settings/email-calendar`. See "Not drivable".

### API tokens (settings-tokens.png)

- S32 · M-05 · New token is one row with a name input and a pine `Create`. Scopes show the raw scope name first (`capture:write`) with the sentence as the second column. The empty table line is `None yet. Create one above and paste it into your assistant's MCP settings.` (instructs). · Sheet: `NEW TOKEN` caps, `It may` checkboxes with the sentence first and the scope in mono under it, `Create token` under the form, a copy-once panel, and `YOUR TOKENS 2 live · 1 revoked` with `···` rows. · **port**

### Connection apps (settings-connection-apps.png)

- S33 · M-08 · Field labels are CAPS field-labels (`REDIRECT URI`, `CLIENT ID`, `SECRET`) with full-width inputs, under bone bands `Google OAuth client · not configured`. · Sheet: sentence-case labels (`Redirect address`, `Client ID`, `Client secret`), a short input, the stored secret shown as `●●●● set 10-07` with `Replace`, and `GOOGLE 2 members connected`. · **port**

### Currency & FX (settings-currency.png)

- S34 · contract §1 invariant-line test · Every superseded rate row repeats `superseded · kept for events before the newer rate` (7 times). · Sheet: a range per row (`events 07-01 to 09-30`). · **bug** · `settings/currency.tsx`
- S35 · M-08 · The title is `Currency & FX rates` (nav and sheet: `Currency & FX`). The band reads `Rates 10 · sparse, dated, newest wins` (doctrine). · **nit**

---

## 3. Spaces index `/spaces` (spaces.png, spaces--scrolled.png, spaces-new-window.png)

Never ported to p-I-0 sheet 00. **Confirmed.**

- X1 · I-00 · The group head is a **44px bone band** `Market map 26 · 18 nested`, with CAPS column heads `COMPANIES MEMOS TERMS` inside it. · Sheet: a mono caps `MARKET MAP` label on a hairline, with lowercase mono column heads `companies · memos · terms · last filed`. · **port** · `routes/_app/spaces.tsx`
- X2 · I-00 · **No `last filed` column.** · **port**
- X3 · I-00 · Rows measure **40px** (LedgerRow), and every row is ruled. · Sheet: 36px rows, rules only between top-level groups. · **port**
- X4 · I-00 · Children get a `›` chevron indent. · Sheet: tree connectors `├` `└` in rule grey. · **port**
- X5 · I-00 · **No `1 archived · show` fold.** With Launch archived (v2-spaces-with-archived.png) the index contained no "archived" text at all, so an archived space can't be found from the index. · **port**
- X6 · I-00 · The `+ New space… nest it under a parent, or stamp a saved breakdown  S` row **exists**, at the end of the list. No deviation.
- X7 · I-00 · The head count is `26 spaces   18 nested` under the title. · Sheet: `11 spaces · 6 nested` beside the title. · **nit**
- X8 · I-00 (New space window) + owner rule · The window head is `New space` plus a mono subtitle `A market or theme to research. Nest it to build the map.` plus **`esc`**. The body has a sentence `Optionally stamp a saved market-breakdown pattern.` beside `From template`, and the NAME label crowds it with no gap. The label is `PARENT` with `None — top level`. The foot has **only** `Create space`, with no `Cancel`. · Sheet: `name`, `inside` (the parent path), `+ Stamp a saved breakdown`, `Create space ↵`. Owner: no esc, one close in the foot (Cancel). · **bug** (esc, missing Cancel, subtitle fails the invariant-line test) + **port** · `routes/_app/spaces.tsx` new-space dialog

## 4. Space page `/spaces/$id` (space*.png, v2-launch-*.png)

The page is in the D74 anatomy. The deviations are smaller:

- P1 · I-01/02 · The details column holds `Criteria`, `Watching 0` and `What's moving 0` **above** Map, Glossary and Tasks. · D73 amended: Map, Glossary, Tasks. (Criteria and watches came later through D71/D72 slices; this is beyond the sheet rather than against it.) · **nit**
- P2 · I-01 · The head adds a **disabled grey `Add watch`** button and a switch-style `Sensitive`. · Sheet: a `Not sensitive` toggle button, `Note here N`, `···`. · **nit**
- P3 · D74 "empty tabs grey" · `FILES 0` and `RECORDS 0` are drawn exactly like `COMPANIES 1` (graphite). · Sheet: an empty tab drawn lighter (`Records 0` at disabled grey). · **port** · `components/ui/tabs.tsx` (no empty state on a tab)
- P4 · I-01 · The Companies tab has no column heads (company / funding stage / pipeline / location), and sort is an outlined `Select` (`Funding stage ⌄`) rather than `Sort Funding stage ▾`. · **nit**
- P5 · I-02 · Notes filters are `FILED 0 · MENTIONS 0`. · Sheet: `All 7 · Filed here 4 · Mentions 3` plus `Sort Updated`. · **nit**
- P6 · I-01 · Map's add row reads `+ Break it down — add a subspace`, which is instructional. · Sheet: `+ Subspace`. · **nit**
- P7 · I-03-D · The archived notice is a double frame with **no solid shadow**, reading `Archived. Out of the tree and the space picker.` and `n filings kept`. It **never mentions watches.** · D73 amended: "its filings stay, and its watches are paused." The stale claim survives in `ArchivedNotice`'s doc comment ("Watches are not built yet, so only the filings are counted") while the page above it shows a Watching section. · **bug** · `components/space-page.tsx:520-560`
- P8 · I-03-B · The Rename field is a bare underline with no box and no `↵ save  esc cancel` hint. · **nit**. Rename focus is covered in Confirmed/denied.
- P9 · I-02 · The archived space's Notes tab rows render at full ink (`op=1`, `oklch(0.24…)`). The note's own `FILED IN SPACE  Launch ×` chip is also full ink, with no outline and no strike. · Sheet I-03-D: the archived name and rule go grey. · **bug** (see "Note chips don't dim") · `components/space-page.tsx` (notes tab), note page filing chips

## 5. List pages (companies / people / deals / portfolio vs Shell p-J-0 03)

- L1 · J-03-A · Each list head prints a **blurb** under the title. Companies: `Every company you track — deduped by domain, tagged into spaces.` Deals: `One record per opportunity — born at Pre-lead… History is the point.` Portfolio: `…Staleness is visible on purpose.` People and Files have the same. · Sheet: `Companies 312`, a serif title with a mono count beside it. The 2026-10-08 rule: "page blurbs go too". · **bug** (commentary) · `PageHeader` callers in `companies.tsx`, `people.tsx`, `deals.tsx`, `portfolio.tsx`, `files.tsx`
- L2 · J-03-A · Saved views are **CAPS underline tabs on their own row** (`ALL | SERIES A AND LATER 29 | Filter | + Save view`), under a separate row holding the filter input, `Columns` and `37 companies`. · Sheet: views as **real tabs** (tab-open, on a bone bar) `All 312 · Pipeline 41 · + view`, with `Filter Sort Columns` on the right of the same bar. `ALL` carries no count. · **port** · `components/views/view-bar.tsx`, `TableToolbar`
- L3 · J-03-A · `New company` (pine) has no key hint. Deals and People are the same. · Sheet: `+ New company C`. · **nit**
- L4 · contract §1 "record table keeps its 36px rows" · Row height is **41px on /companies and /people** but 36px on /deals, /portfolio and /files. · **bug** · `record-table.tsx` (the checkbox lane or the chip cells grow the row)
- L5 · contract §2 `RecordTable` "sticky head" · Scrolling /companies by 500px folds the page head, but the **column heads scroll away**: the sticky `th` is inside the horizontal `overflow-auto` wrapper while `main` does the vertical scroll (companies--scrolled.png). · **bug** · `record-table.tsx`
- L6 · contract Numeral rule (comparable figures `numeric`, right-aligned) · Portfolio's Invested, Current value, Realized, MOIC and Gross XIRR cells are **left-aligned** (`text-align:start`). Deals `Value` is right-aligned. · **bug** · `routes/_app/portfolio.tsx` columns
- L7 · contract Numeral/dates · Portfolio `Last mark` prints `Sep 2025`, and the companies/people `Added` column prints `Oct 10, 2026`. Elsewhere dates are ISO mono (`2026-09-20`, `10-06`). · **nit**
- L8 · Portfolio · The readout line under the head is inline small text (`Invested $2.7M  Current value $5.9M …`), not a readout strip. Next to it is a crimson sentence: `1 holding excluded from totals — fx rates missing (Settings → FX rates)`. The table stops at x=1304, not full width. · **nit**
- L9 · /deals · Three filter rows: views (`ALL | IN DILIGENCE 2 | …`), toggle chips `Active 9 / Parked 2 / Closed 17` (tinted), and an unstyled stage row `Pre-lead Screening Meeting Diligence Term sheet`. There's no list `···` (Companies and People have one). · **nit**
- L10 · /companies · A bone banner `4 possible duplicates to review   Review →` sits above the toolbar. · D79: Today is the one attention surface. · **nit**
- L11 · Column heads are sentence-case mono (`Company`, `Domains`). · Contract §1: column heads are CAPS. Sheet: lowercase mono. · **nit**

## 6. Files `/files`, `/files?filed=unfiled` (files.png, files-unfiled.png)

- F1 · contract §2/§3 ("`ViewBar` — object surfaces only … a shelf is not one") · /files renders the ViewBar (`ALL | Filter | + Save view`) **and** an `All | Unfiled` segmented control: two ways of saying "all". · **bug** · `routes/_app/files.tsx`
- F2 · L1 · Blurb: `Every file in the workspace… Kind, filing and space are the three axes a folder tree encodes — there are no folders.` (doctrine, 2 lines). · **bug** (same as L1)
- F3 · At 1440 the table needs horizontal scroll: `Date` and `Size` sit at x 1413–1585. · **nit**
- F4 · The unfiled empty state is `Nothing unfiled.` plus `Every file in the workspace is filed against a record or into a space.` (doctrine) plus `Show all files`. · **nit**
- F5 · p-F-0 has no sheet for the /files shelf (00 kit, 01 record tab, 02 adding, 03 viewer, 04 folder link), so /files was only checked against the contract. The record Files section is covered in R8 and R24. · **unconfirmed-sheet**
- `/documents` 301s to `/files?filed=all`. No deviation.

## 7. Today `/today` (today.png, v2-sidebar-collapsed.png)

- T1 · contract §1 "A readout" · The readouts are a **CAPS 10px label on top** (`OVERDUE`) with the value under it at **20px** (measured). · Sheet O-00: `2` at 22 above `Overdue` in sentence case. Record pages do it correctly. · **bug** · `routes/_app/today.tsx`
- T2 · O-00 · The head is `Today` with the date line `Sat 10-10 · W41` **under** it, and there are no head actions. · Sheet: the date above the title, plus `New task T` and pine `Log interaction L`. · **port**
- T3 · O-00 · The day strip spans **00–21+** across the full width, with all of the past dithered and the now-dot near 20:00. There's no `now · 11:40` label and no meeting blocks (none seeded). · Sheet: a working window 08–20 with named meeting blocks and `now · hh:mm`. · **nit**
- T4 · O-00 / D79 · The **Meetings section is absent**: no `‹ today ›`, no now-rule, and no `Connect Google ›` in place (D80). · **port**
- T5 · O-00 / D79 · **What's moving** is absent; the rail ends at `team activity › 4 · 24h`. · **port**
- T6 · O-00 · Needs-you kind filters are real CAPS tabs `ALL 9 TASKS 5 DEALS 0 MARKS 4 REVIEW 0`, with no Meetings kind. · Sheet: sentence-case filters in the head on the right (`All Tasks 5 Review 5 Deals 2 Meetings 1 Marks 1`). The fold `+1 show all ›` lacks the kind breakdown (`+ 6 more · 3 tasks · 2 review · 1 deal`). · **nit**
- T7 · No notices band shows; nothing in the seed stops the machine. It could not be checked. · see "Not drivable"
- T8 · O-00 · The rail's `Portfolio` is a sentence-case band title with `CURRENT VALUE` and `REALIZED` rows. · Sheet: `PORTFOLIO` caps, `VALUE`, `MOIC`, `1 HOLDING UNPRICED add EUR→USD ›`. · **nit**

## 8. Cmd-K (cmdk-*.png)

- K1 · H-01 · Opened on a record, the palette lists `ACTIONS 3`: Log interaction L, **Note about this** (no key), File in a space…. The first row isn't highlighted, and there's no `ACTIONS · ON <record>` scope or `on Flent` tag in the input. · Sheet: `ACTIONS · ON FLENT 4`: Log interaction L, Write email E, **Add task T**, File in a space… `in 2 now`, with the first row in bone. · **port**
- K2 · H-01 ("On a page without a record the list is empty and the input's hint is the only line") · On Today the palette shows `ACTIONS 2: Add a task T, Upload a file…`. · **port** · palette
- K3 · H-02 · Passages (a note snippet, the deck text) are mixed into `RECORDS`. · Sheet: separate `RECORDS` and `PASSAGES` groups. · **port**
- K4 · **bug** · Snippets print raw wiki-link markup: `…leaks there. [[Vayu Orbital|e…`, `…moves under everyone. [[Va…` (cmdk-record-typed.png). · palette snippet renderer (strip `[[name|entity:id]]` to the name)
- K5 · H-02 · The preview pane's `Last contact` readout clips to `10-06 …`. · **nit**
- K6 · H-01/02 · The foot is `↑↓ move · → actions`. · Sheet: `⌘↵ open in rail` and `tab · ask a question` (Ask is unbuilt, project 24). · **nit**
- K7 · Kind lane is `companies` / `deals` (the object plural slug). · Sheet: `company · seed · Proptech › Property ops`. · **nit**

## 9. Shell (sidebar, sticky head, dialogs)

- H1 · owner decision (active row = hairline box) · The active row is a **paper fill joined through the sidebar's right edge** (a tab cut, crop-sidebar evidence in note.png: the white runs from x 12 to x 232 with no rule). The collapsed rail draws a box. · **bug/port** (reverses the shell sheet; the owner's rule is unbuilt) · `components/app-sidebar.tsx`
- H2 · owner decision (no `esc`, no cross, one close = Cancel) · `DialogHeader` prints `esc` (sr-only "ape — close") in **every** dialog walked: New space, Log interaction, Edit/New attribute. There's no cross. New space has **no Cancel**. Log interaction and the attribute window do have Cancel. · **bug** · `components/ui/dialog.tsx:77-83`; `routes/_app/spaces.tsx` new-space foot
- H3 · contract §1 Commentary · Dialog subtitles restate scope (`A market or theme to research. Nest it to build the map.`), and Log interaction carries `+ You're included automatically via the log entry.` · **nit**
- H4 · J-00-A · Tasks has no `3 due` count in its lane (it shows `G K`). There's no Ask row (project 24), no Meetings row `G E` (contract §5), and no `+` on the Objects group head. The search field has no glyph. · **port / nit**
- H5 · **bug** · Review's head tabs (`ALL 4 · SUGGESTIONS 0 · DUPLICATES 4`) don't fold into the sticky head. Scrolled 300px, they hang across the folded head's bottom rule at y≈37 with their underline at y≈55, over the cards (v2-review-scrolled-300.png). · `routes/_app/review.tsx` / `PageHeader` tabs slot vs `HeadBar`
- H6 · Scroll restoration replays the previous scroll on a fresh `goto` of the same path (General opened 49px down, Review 619px). Worth checking it's intended. · **nit**

## 10. Other routes

- O1 · /review (v2-review-top.png) · The head meta is `4 open   you make the call   rejected and dismissed never come back` (doctrine, "never"). Cards carry a 3px solid shadow on the page (contract: `shadow-solid` is for a window over the scrim). · **nit** · `review.tsx`
- O2 · /inbox and /dedupe 301 to /review. No deviation.
- O3 · /tasks · The composer hint is a sentence with examples (`Add a task — "chase data room Friday", "revisit after their raise"…`). · Contract: an ellipsis invitation. · **nit**
- O4 · /notes · List titles are sans, while record and space Notes sections print note titles in serif. No space chips on rows. · **nit**
- O5 · /mandate · `3 of 6 · click toggles` (an instruction) and `whole units · flags, never blocks` (doctrine) in the mono lane. · **nit**
- O6 · /notes/$id · `FILED IN SPACE` / `FILED AGAINST` use dashed `+ File in space…` chips. The handles bug is covered in Confirmed/denied. · no deviation beyond that
- O7 · /import · Matches its shape (stepper, P5 dropzone, `Continue ⌘↵` disabled pine). No deviation.

---

## Confirmed / denied

| Item                                                                                                                        | Verdict                                           | Evidence                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab transition flash (space tabs)                                                                                           | **Confirmed**                                     | Sampled per frame after Notes→Companies: at 37ms from=`rgba(28,28,26,0.62)` to=`rgba(28,28,26,0.38)`; at 54ms 0.36/0.64; both tabs carry partial ink for about 150ms. `space-tab-flash-40ms.png` shows a grey block on the old tab. `tabs.tsx:118` `transition-colors` on a `tab-open` ink background |
| Editor `+`/`⠿` handles over the sidebar                                                                                     | **Confirmed**                                     | `.bn-side-menu` at x 216–264 while the sidebar ends at 232; `elementFromPoint` on the handle hits the handle's svg, so it paints over the sidebar (`note-handles-hover.png`; same at 1100px)                                                                                                          |
| Rename `···` focus trap on the space head                                                                                   | **Confirmed** (focus is lost rather than trapped) | After a real click on Rename, activeElement is `DIV` at 30ms, then `BODY` at 150/400/900ms. Typed text doesn't reach the field. Tab goes to the first page link (`Harbour Lane home`). `space-page.tsx` `opening()`/`keepFocus`                                                                       |
| Note chips don't dim on an archived space                                                                                   | **Confirmed**                                     | With Launch archived: the note page's `Launch` filing chip is `op=1`, ink, no decoration. The space's own Notes-tab rows are full ink. The company rail's `Launch` is unchanged graphite (`v2-note-of-archived-space.png`, `v2-launch-archived-notes.png`)                                            |
| Settings Email & calendar / Connections: action column clipped                                                              | **Not reproduced (not drivable)**                 | Without the google plugin installed, no row action renders (`Not available yet`, even after saving an OAuth client). `/settings/connections` 301s to email-calendar                                                                                                                                   |
| Settings forms in jsonb key order (plugin forms)                                                                            | **Confirmed by code read, not visually**          | `lib/integrations/settings-form.ts:223` iterates `Object.entries(parsed.data.properties)` from the stored `integration.manifest` jsonb, which Postgres reorders by key length then bytes. The comment at :208 claims "declaration order". No plugin was installable in the harness                    |
| Stale "watches aren't built" on the archived notice                                                                         | **Half-confirmed**                                | The visible notice doesn't say it, but it omits watches altogether. The stale claim lives in `ArchivedNotice`'s comment, while the page shows a Watching section. D73 wants "watches are paused"                                                                                                      |
| Cmd-K: a note titled with a record's name outranks the record                                                               | **Confirmed for a prefix**                        | On the company page, `Vayu` ranks the note `Vayu Orbital — first call` 1st, the deck file 2nd and the company 3rd. The full name `Vayu Orbital` (on Today) ranks the company first; `orb` too. Sheet H-02: "a name typed always puts that record first"                                               |
| Owner: no `esc` anywhere, no cross, one close (Cancel)                                                                      | **Violated**                                      | `esc` in the settings nav head and in every `DialogHeader`. No cross seen. New space lacks Cancel                                                                                                                                                                                                     |
| Owner: sidebar active row = hairline box                                                                                    | **Violated**                                      | Paper tab cut through the edge (expanded). The collapsed rail draws a box                                                                                                                                                                                                                             |
| Owner: settings group heads as mono caps labels, ~700px column, General Logo-before-Name with Remove, no Base currency hint | **Violated** (all parts)                          | 44px bone bands everywhere. Column 900px. Name before Logo, no Remove. Hint present                                                                                                                                                                                                                   |
| Owner: Spaces index matches I-00                                                                                            | **Violated**                                      | Bone band + CAPS heads, 40px rows ruled throughout, chevrons instead of connectors, no last filed, no archived fold. The `+ New space…` row does exist                                                                                                                                                |
| Owner: record body (D74) never ported                                                                                       | **Confirmed**                                     | Company, person, deal and custom all stacked (R1–R24)                                                                                                                                                                                                                                                 |
| Owner: Files sheet unconfirmed                                                                                              | Applied                                           | R8, R24 and F5 are tagged `unconfirmed-sheet`                                                                                                                                                                                                                                                         |

## Console errors

**None.** Zero `console.error` and zero `pageerror` across both passes and every route above. The capture was proven live by a deliberate `console.error('walk2 console capture works')`, which was logged.

## Not drivable

- **Plugin page template and plugin settings forms.** The harness registry shows `Available 0` and nothing was installed, so `/settings/plugins/$id` and the manifest form couldn't be rendered. jsonb key order is confirmed from code only.
- **Email & calendar / Files / Meeting notes with a connected account.** No google or box plugin, so no Connect, Options or Reconnect row. The clip bug couldn't be reproduced.
- **Today's notices band and the Meetings section.** The seed has no enrichment cap, broken connection or calendar. Meetings is unbuilt regardless.
- **Ask** (p-K-0): no route or panel exists, so it wasn't compared. **Meetings** (p-N-0): no route. **Email viewer** (p-G-0): the seeded interactions have no email body, so the viewer wasn't opened; only E1's ledger rows were compared (R7).
- **Starred spaces in the sidebar**: none starred in the seed (Star exists in the space `···`).
- **Move to… window** (I-03-C): not opened, to avoid reparenting the throwaway tree mid-walk.

## Counts

Each numbered entry counts once, under its primary class (S6, X6, S31, T7 and O2/O6/O7 are no-deviation or not-drivable notes):

- **bug: 27**: R10 R14 R17 R19 · S1 S5 S23-caption S24 S26 S27 S34 · X8 · P7 P9 · L1 L4 L5 L6 · F1 F2 · T1 · K4 · H1 H2 H5 · plugin-form jsonb order
- **port: 48**: records 13, settings 21, spaces index 5, space page 1, lists 1, Today 3, Cmd-K 3, shell 1
- **nit: 42**
- **unconfirmed-sheet: 3**: R8 and R24 (counted as port), F5 (informational)

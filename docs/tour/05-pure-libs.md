# Chapter 5 — pure libraries: portfolio math, storage, vault, extraction

These are the unit-tested libraries with no database access (storage and
vault touch the filesystem and DB at their edges but keep their logic
pure). The contract with chapter 4: **pure libs take numbers; the server
boundary parses drizzle's numeric strings before calling**. Dates are ISO
strings compared lexically throughout.

## `portfolio/xirr.ts`

The gross-XIRR solver: the annualized rate where the NPV of dated cash
flows is zero. Sign convention: negative = money out, positive = money in.
Day count is Actual/365, which is deliberate: it's what Excel's XIRR uses,
and the test suite anchors on matching Excel to five decimal places.

The algorithm: guard (fewer than two flows, or all one sign → null), sort a
copy by date, then a zero-elapsed-time guard: if all flows share one date,
NPV is rate-independent and every rate is a "root"; Newton would just
return its initial guess, so the function returns null. The rate is
undefined, not 10%.

Then Newton-Raphson from a neutral 0.1 guess, up to 50 iterations, with an
analytic derivative. It bails to **bisection** when the slope is zero or
the next iterate leaves the domain `(-0.9999, 10]`. Bisection needs a sign
change across the bracket (else null) and runs up to 200 halvings. Deeply
negative rates (an investment that went to almost zero) are reached via
bisection because Newton overshoots the domain.

Only `metrics.ts` calls it.

## `portfolio/metrics.ts`

The derived-metric kit: cost basis, realized, unrealized, MOIC / TVPI /
RVPI / DPI, gross XIRR, all computed live from event rows and as-of-date
capable. It also encodes the currency convention: **cash flows convert at
transaction-date rates; unrealized value converts at the as-of-date rate**,
so FX gain and loss land inside base-currency performance.

The result is a Result type, and this is the honest-FX contract:
`{ok: true, metrics}` or `{ok: false, missingRates: [{currency, date}]}`.
A missing rate fails the whole computation with a list; nothing ever
assumes rate 1.0.

Semantics worth knowing exactly:

- `asOf` defaults to the sentinel `'9999-12-31'`; all three event arrays
  filter by `date <= asOf`, lexically.
- A single-currency holding computes natively with no rates at all, unless
  the caller forces `reportIn: 'base'` (which the roll-up does, since
  holdings in different currencies must land in one denominator).
- **writtenOff**: a writeoff distribution zeroes residual value even
  without a final zero mark, but a mark dated strictly after the latest
  write-off wins. Revivals happen; the newest dated statement about value
  is the truth.
- **unrealized**: zero if written off; else the latest mark converted at
  the as-of rate; else falls back to cost basis when never marked
  (staleness stays visible via `lastMarkDate: null`).
- Ratios divide by cost basis (null when zero). MOIC and TVPI are
  literally the same expression here; both names exist for call-site
  meaning.
- **grossXirr** builds flows from investments (negative) and distributions
  (positive), plus a terminal flow of unrealized value at the as-of date.
  Total loss is special-cased: cost basis > 0 and realized + unrealized
  = 0 gives exactly −1. The solver has no root there; the rate is −100%
  by definition, not undefined.

The tests read like a spec: as-of filtering ("the past has no knowledge of
later marks"), write-off then revival, the mixed-currency example (cost at
the historical rate, value at the as-of rate), and the missing-rate
failure with its exact payload.

## `portfolio/ownership.ts`

Instrument-aware ownership in three tiers, and a percentage is never
faked:

1. **actual**: requires at least one priced investment with shares. For
   each round carrying a fully-diluted share count, our cumulative priced
   shares at that date over the round's outstanding gives a point; the
   result is an ownership **history** with dilution per round, plus
   `currentPct`. Deliberately not cap-table management. Rounds without a
   share count produce no point; staleness stays visible.
2. **implied**: only when _every_ investment in the window is a post-money
   SAFE with a cap. `pct = Σ amount/cap`, locked at signing. The UI renders
   it as `~X%`.
3. **cost_basis_only**: everything else. Pre-money SAFEs, CCDs, or any mix
   including an unconverted instrument. Mixing a post-money SAFE with a CCD
   degrades the whole holding: better no percentage than a wrong one.

## `portfolio/fx.ts` and `portfolio/format.ts`

`rateFor(rates, currency, date, base)`: the latest rate dated at-or-before
the requested date; the base currency is always 1; no rate at-or-before →
null, and there is **no forward fallback** (a rate dated only after the
request is not used). Unknown currency → null, never 1.

`format.ts` is client-safe display formatting. `fmtMoney`'s compact path is
hand-rolled (thresholds K/M/B, one trimmed decimal) because Intl's compact
notation differs between Node and Chrome ICU builds, which breaks SSR
hydration; that's the CLAUDE.md trap. The currency _symbol_ still comes
from Intl via formatToParts; only the compact notation is hand-rolled.
`fmtMultiple` (`2.40×`), `fmtPct`/`fmtXirr`, and `fmtDate` (month + year,
parsed at local midnight to dodge UTC day-shift) round out the kit. Note
there are two date formatters in the app on purpose: this one (portfolio
staleness, month granularity) and `lib/format.ts`'s `formatDate`
(full dates for table metadata).

## `tasks/parse-due.ts`

The task composer's natural-language dates: a tiny deterministic grammar,
explicitly not AI. Same string plus same `today` always gives the same
date; `today` is injected for purity and comes from `localToday()`, which
builds the ISO date from local calendar parts (not `toISOString`, which
would be UTC).

The grammar: `today`/`tod`, `tomorrow`/`tmrw`/`tom`, `next week` (+7),
`next month` (+1 calendar month), weekday names (always the **coming**
instance, 1–7 days out; "next friday" is accepted but changes nothing,
because a 13-day "next friday" surprises more than it helps; saying
today's own weekday means next week's), `in (a|N) day|week|month[s]` with
N capped at 365, and a bare ISO date that must round-trip (so `2026-02-30`
is rejected, not normalized). Everything else → null and the UI falls back
to a date input. Month arithmetic clamps overflow: Jan 31 + 1 month is
Feb 28/29, not Mar 2.

## `documents/extract.ts`

In-process text extraction over raw bytes; no extraction containers. The
design center is a three-way outcome, not a boolean:

- `done` with text,
- `unsupported`: no text layer we can reach. A scanned deck is a normal
  document, not a failure; the PDF-specific reason string pre-announces
  the upgrade path ("extractable once a vision model key is configured").
- `failed`: we tried and broke (corrupt file, bug).

Collapsing the last two would produce "extraction failed" on a perfectly
good photo of a term sheet.

`detectFormat` prefers the file extension over the mime type, because
browsers report `application/octet-stream` for real .pptx files and Gmail
attachments are worse. Per-format paths:

- **pdf**: dynamic `import('unpdf')`, on purpose: unpdf drags in a pdf.js
  build, and the web process must never load it. The byte buffer is copied
  because unpdf transfers it.
- **docx**: mammoth raw text.
- **pptx**: fflate unzip plus regex-over-XML. Every `a:t` run per slide
  (tables and grouped shapes, not just title placeholders), slides in
  numeric order (slide10 after slide9; lexical sorting gets that wrong),
  plus speaker notes, which is often where the actual numbers get said.
- **xlsx**: values row-wise, tab-separated, under real sheet names
  resolved through the workbook rels (sheet names like "Cap Table (post)"
  are the most searchable string in the file). Shared strings concatenate
  rich-text runs, or "Series A" arrives as "Series".

Normalization caps text at 2MB and **never folds tabs into spaces**: tabs
are the xlsx column separator, and folding them turns a cap table back
into prose.

The tests build their zip fixtures in-code with fflate rather than
committing binaries, because the parsers are regex-over-XML and the XML
shape is the thing under test.

## `storage/` — the drivers

`types.ts` freezes the interface, and its comments carry the contracts:
keys are content-addressed (sha256 of the file), so dedupe is free, blobs
are immutable, and cache headers can say forever. Presigning matters
because a 200MB deck must not stream through Node.

**`local.ts`** (default): blobs at `<DATA_DIR>/blobs/<aa>/<sha>`, plain
files the operator can tar. "Presigned" URLs are app routes carrying a
short-lived HMAC token signed with the vault master key. `blobPath` throws
unless the key is 64 hex chars, which doubles as the path-traversal
defense. The important method is `putContentAddressed`: it streams the
upload through a transform that counts bytes (erroring past the size cap)
and feeds sha256, then requires the digest to equal the key before an
atomic rename into place. Without this, the key is whatever the client
claimed, and "same sha ⇒ same bytes" — which dedupe, the immutable cache
header, and the extraction worker all lean on — dies the first time a
client lies or an upload truncates. S3 gets this from the service; local
must do it itself because the app _is_ the store.

**`s3.ts`**: one driver for every S3-compatible target (AWS, R2, B2,
MinIO, Garage). Uploads are presigned PUTs with the sha256 baked into a
**signed, unhoistable header**, so the bucket, not the app, verifies the
bytes; a PUT without the header fails the signature. Download URLs bake
`attachment; filename=…` and `application/octet-stream` into the signed
response params, mirroring the local route's stored-XSS hardening: an
uploaded .html can never be served inline from the bucket either. The file
header documents the researched checksum matrix: AWS and MinIO enforce,
R2/B2 added support, Garage is doubtful, which is why the worker re-hashes
on read as the third line of defense.

`index.ts` picks the driver from `STORAGE_DRIVER` and memoizes the
instance.

## `vault/` — BYOK secrets

`crypto.ts`: AES-256-GCM with the master key, random 12-byte IV, and the
AAD set to `scope:provider`, which binds a ciphertext to its context: a row
copied between credentials fails authentication instead of decrypting.
Wire format is `[version][iv][tag][ciphertext]`. `redact` produces the
only form the client ever sees.

`key.ts`: master key resolution: `MASTER_KEY` env (base64, exactly 32
bytes), else `<DATA_DIR>/secret.key`, else auto-generate on first boot
with a loud "BACK THIS FILE UP" warning. The one key is a three-way root
of trust: credential encryption, the local blob URL HMAC, and the Better
Auth session secret (via HKDF in auth.ts). Losing it breaks stored API
keys, in-flight blob URLs, and sessions at once, which is why the backup
script's both-or-neither rule includes it.

`index.ts`: `storeCredential` (upsert per scope/provider/user, returns
only the redacted display) and `resolveSecret` (user key → workspace key →
null; null means the feature is hidden, not broken). `resolveSecret`
currently has zero callers: it is the plumbing waiting for the BYOK AI
phase.

## `format.ts` and `utils.ts`

`lib/format.ts`: one module-level `Intl.DateTimeFormat` and one
`formatDate` (`Jul 30, 2026`), locale pinned to `en` so a column of dates
is internally comparable. `utils.ts` is the standard shadcn `cn` helper.

## Invariants to carry forward

- Numbers in, strings stay at the boundary; no parsing inside pure libs.
- Missing FX is a first-class failure with a payload, surfaced on Today.
- "Same sha ⇒ same bytes" is enforced three times: local streaming
  re-hash, S3 signed checksum header, worker read-time re-verify.
- Stored-XSS hardening (octet-stream + attachment) is mirrored across both
  drivers and the preview path.
- Never touch the hand-rolled compact money formatter without re-reading
  the hydration trap.

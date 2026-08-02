# Private-capital glossary — the domain behind the financial engine

Written 2026-08 to inform the portfolio layer (CONTEXT.md phase 15) and everything after
it. Sources: standard industry usage plus the surveyed products — TagHash, Edda, Totem,
Fundwave, Affinity, Visible, Carta — each of which is really a bet on *which slice of
this glossary to productize*.

Annotations tie terms to our architecture:
- **[P15]** — modeled in the phase-15 portfolio layer (or already shipped).
- **[banked]** — recorded future work with a decided shape.
- **[fenced]** — deliberately out of scope (fund-administration tier); understand it,
  don't build it.

---

## 1. Actors & structures

- **GP (General Partner)** — the fund's managers; legally the entity that runs the fund
  and carries unlimited liability (in practice via an LLC). In our world: the workspace.
- **LP (Limited Partner)** — investors *in the fund* (endowments, family offices,
  wealthy individuals). They commit capital, receive reports, and stay passive.
  **[fenced]** — LP-facing anything is the recorded non-goal.
- **Management company / ManCo** — the GP's operating business that collects fees and
  pays salaries; distinct from the fund vehicle itself.
- **Fund / vehicle** — the pooled legal entity (usually an LP-structure or, in India, an
  AIF) that actually holds the investments. One GP typically raises successive funds.
  **[P15]** — one nullable `vehicle` label on money events, data not tenancy.
- **Vintage** — the year a fund starts deploying. Funds are benchmarked against same-
  vintage peers because macro timing dominates returns.
- **SPV (Special Purpose Vehicle)** — a single-deal entity raised ad-hoc, common for
  syndicates and pro-rata top-ups. **[fenced]** as a structure; representable as a
  `vehicle` label.
- **Fund of funds (FoF)** — a fund whose holdings are other funds; needs *look-through*
  (below). **[fenced]** — wrong customer.
- **Angel / syndicate / family office / accelerator** — the small end of the market and
  our design target: check-writers without fund-admin apparatus.

## 2. Fundraising & capital mechanics *(the layer Fundwave lives in)*

- **Commitment** — an LP's contractual promise of capital ("$5M to Fund II"). Total
  commitments = fund size. **[fenced]**, save the "lightweight capital ledger if fund-I
  customers ask" note.
- **Capital call / drawdown** — the GP demanding a slice of a commitment when cash is
  needed; delivered as a **capital notice**. Fundwave's "beautiful capital notices" is
  this, productized.
- **Paid-in capital (PIC)** — cumulative capital actually drawn. The denominator of DPI
  and TVPI.
- **Unfunded commitment** — committed minus paid-in; the LP's remaining obligation.
- **First close / final close** — fundraising milestones; a fund can start investing
  after first close while still raising.
- **LPA (Limited Partnership Agreement)** — the fund's constitution: fees, carry,
  waterfall, term, everything. Every fund's LPA is slightly bespoke, which is why fund
  accounting resists standard software.
- **Side letter** — per-LP amendments to the LPA (fee breaks, co-invest rights). A major
  reason allocations get hairy.
- **GP commit** — the GP's own money in the fund (typically 1–2%), aligning incentives.
- **Recycling** — reinvesting early exit proceeds instead of distributing them; changes
  the meaning of "fund size deployed" and complicates TVPI.
- **Capital account** — per-LP ledger of contributions, allocated gains/losses, fees,
  and distributions. The atomic unit of fund accounting; what Fundwave's "automated
  allocations" maintain. **[fenced]**.

## 3. Sourcing & deal flow *(the layer Affinity/Edda lead; largely shipped for us)*

- **Deal flow** — the stream of investable opportunities. Quality ∝ network.
- **Warm intro** — an introduction through a mutual connection; the currency of VC
  sourcing. *Relationship intelligence* (Affinity's moat) = mining email/calendar to
  find the warmest path. **[banked]** — our `interaction_entity` graph + Gmail sync.
- **Thesis** — a falsifiable market belief driving sourcing. (We removed it as an
  object, 2026-08; it lives as prose in spaces.)
- **Mandate** — the fund's prescriptive strategy: stages, geos, check size, portfolio
  construction. **[shipped]** — phase 11, including the outside-mandate hint.
- **Pipeline / stages** — the funnel from first contact to invested/passed.
  **[shipped]** with editable stage vocabulary and stage-group semantics.
- **IC (Investment Committee)** — the partnership meeting that decides; produces IC
  memos and votes. **Scorecard** — structured per-partner evaluation, often weighted
  (Edda). **[banked]** for multi-member workspaces.
- **Data room** — the folder of company documents opened during diligence.
- **Term sheet** — the non-binding offer: valuation, amount, rights.
- **Pass vs. lost** — *we said no* vs. *they said no / missed allocation*. Different
  post-mortem lessons; **[shipped]** as distinct terminal stages.
- **Signaling risk** — the ideology that a top-tier fund *not* following on is read by
  the market as negative information; shapes whether founders want funds on small
  checks.

## 4. Instruments & rounds *(phase-15 foundation)*

- **Priced round** — equity sold at a negotiated valuation. **Pre-money** (value before
  the new cash) + amount raised = **post-money**. Price per share = pre-money ÷ fully
  diluted shares. **[P15]** — the `round` object.
- **SAFE (Simple Agreement for Future Equity)** — money now, shares later, priced at
  the next round with a **valuation cap** and/or **discount**. Until conversion there is
  cost basis but *no ownership %*. **[P15]** — the honest-holdings rule: never fake a
  % for unconverted instruments.
- **Convertible note / CCD** — debt that converts to equity; the CCD (compulsorily
  convertible debenture) is the standard Indian flavor for regulatory reasons.
  **[P15]** — instrument enum includes it by name.
- **Bridge** — an interim round (usually notes/SAFEs) between priced rounds.
- **Lead / follow** — the investor who sets terms vs. those who join on them.
- **Allocation** — how much of the round you're permitted to take; "lost allocation" is
  a real loss mode. **[shipped]** as the Lost stage's meaning.
- **Pro rata** — the right to invest in later rounds to maintain your ownership %.
  Exercising it is a **follow-on**. **[P15]** — later investments referencing later
  rounds; ownership ledger recomputes.
- **Down round / flat round** — priced below / at the previous post-money; triggers
  anti-dilution provisions.

## 5. Ownership & the cap table *(Carta's kingdom; we track our position only)*

- **Cap table** — the authoritative registry of every holder's shares and instruments.
  Carta's product is *being* this ledger. **[fenced]** — we model *our* position
  (our shares ÷ shares outstanding), never all holders.
- **Fully diluted** — share count assuming every option, warrant, and convertible
  exercises; the honest denominator for ownership %. **[P15]** — `shares_outstanding`
  on rounds should be the fully diluted count, stated as such.
- **ESOP pool** — shares reserved for employees; the **option-pool shuffle** is
  negotiating pool expansion *pre-money* so dilution lands on existing holders.
- **Dilution** — ownership % shrinking as new shares issue. **[P15]** — the ownership
  ledger's whole purpose: entry % → current %, per round.
- **Liquidation preference** — who gets paid first on exit and how much (1× non-
  participating is standard); the **pref stack** is the ordering across rounds. Affects
  what a mark is *worth* in downside scenarios — a reason marks ≠ payouts.
- **Anti-dilution** — protection repricing earlier investors on a down round (weighted
  average, or the brutal full ratchet).
- **Secondary** — buying/selling *existing* shares (no new money to the company);
  partial exits happen this way. **[P15]** — a `distribution` of kind `secondary`
  carrying shares sold.
- **409A** — the US fair-market-value appraisal of common stock (Carta's cash cow); a
  legitimate mark basis. **[P15]** — one of the mark `basis` values.

## 6. Portfolio & performance *(the phase-15 engine itself)*

- **Holding** — our position in one company: investments − exits, cost basis, current
  value. **[P15]** — born when a deal reaches Invested.
- **Cost basis** — total invested in a holding. **Net cost** — basis minus realized
  proceeds (TagHash's "Your Investment" card).
- **Mark / fair value** — the current estimated value of a holding; each mark carries a
  **basis** (latest round price, 409A, manual) and a date. **Mark discipline** is the
  ideology that marks are evidence-driven and append-only — you never overwrite
  history. **[P15]** — the `mark` table, death-is-information applied to valuations.
- **IPEV / ASC 820** — the valuation guidelines auditors hold funds to; why "structured
  valuation workflows" (TagHash) exist. **[fenced]** as compliance; our mark basis
  field is the lightweight cousin.
- **NAV (Net Asset Value)** — sum of holding fair values + uninvested cash − liabilities;
  fund-level "what it's worth today." **[P15]** computes the holdings sum; cash
  accounting is **[fenced]**.
- **Unrealized / realized** — value still on paper vs. cash actually returned.
- **Distribution** — cash (or shares) returned: exit proceeds, secondaries, dividends,
  write-off recognition. **[P15]** — the `distribution` table.
- **The metric kit** *(all computed live from dated events — never stored)*:
  - **MOIC** — multiple on invested capital: total value ÷ invested.
  - **TVPI** — (distributions + NAV) ÷ paid-in. = DPI + RVPI.
  - **DPI** — distributions ÷ paid-in; the "cash back" multiple LPs trust most.
  - **RVPI** — NAV ÷ paid-in; the still-on-paper remainder.
  - **IRR / XIRR** — annualized time-weighted return over dated cash flows;
    Newton-Raphson with bisection fallback. **Gross vs net**: before vs after fees and
    carry — net is the LP-relevant one and needs the fee engine, hence **[fenced]**;
    we compute gross. **[P15]**
- **J-curve** — the shape of early fund returns: negative first (fees out, no exits),
  then rising. Why young-fund IRRs are noise.
- **As-of / point-in-time reporting** — every metric answerable at any historical date.
  **[P15]** — the append-only-events rule exists precisely for this.
- **Tear sheet** — the one-page holding summary (invested, ownership, marks, metrics,
  commentary) — Totem's flagship artifact. **[banked]** — falls out of the holding
  detail view.
- **MIS / KPI collection** — periodically pulling metrics from portfolio companies.
  The **standard six** (Visible): Revenue, Net Income, Cash Balance, Runway, Net Burn,
  Headcount, via login-free tokenized founder links. **[banked]** with that exact
  shape; a **runway lens** over the portfolio is its first consumer.
- **Look-through** — decomposing indirect exposure (FoF → funds → companies): "which
  companies appear across vehicles". **[fenced]** — though our entity resolution is the
  same idea at the company-identity level.
- **Exposure** — concentration by sector/stage/geo across the book; a computed
  group-by over holdings once spaces/attributes join the portfolio data. **[banked]**.

## 7. Fund economics *(why "net" is hard; all [fenced], understood not built)*

- **Management fee** — annual % (≈2%) charged on committed capital early, often
  stepping down to invested-cost basis later. Fundwave: "fees on Commitment, Cost of
  Investment or NAV," per-LP rates — this is why it's an engine, not a formula.
- **Carry (carried interest)** — the GP's share of profits (≈20%) above a **hurdle /
  preferred return** (≈8%).
- **Waterfall** — the payout ordering: return capital → hurdle → **GP catch-up** →
  80/20 split. **European** (fund-as-a-whole: LPs made whole before any carry) vs
  **American** (deal-by-deal: carry per exit, trued up later). Fundwave supports both
  with layered hurdles — the single best example of LPA-bespoke complexity.
- **Clawback** — LPs recovering over-distributed carry when later deals sour;
  the reason deal-by-deal carry needs escrow accounting.
- **Fee offsets / expense allocation** — which costs the fund bears vs the ManCo;
  audit-sensitive.

## 8. Ideologies worth encoding *(the beliefs that shape good product decisions)*

- **Power law** — returns concentrate in 1–2 holdings per fund; most go to zero. The
  product consequence: the *winner's* record must support deep history (every round,
  every mark), and write-offs deserve one-click honesty, not shame-hiding.
- **Ownership targets & reserves** — funds underwrite to a target % at entry and
  reserve 1–2× initial checks for follow-ons; **pacing** is deploying over ~3 years for
  vintage diversification. All three are *portfolio-construction* prose in the mandate
  today; reserves math is a candidate future consumer of the capital ledger.
- **Loss ratio / graduation rate** — % of dollars in write-offs; % of companies
  reaching the next round. Computable from rounds + distributions once phase 15 lands.
- **Evidence over narrative** — disconfirmation recorded next to conviction (our
  removed-thesis instinct, now prose discipline).
- **Access vs. picking** — the belief that returns come from *getting into* the best
  deals more than selecting them; why warm-intro graphs and signaling matter.
- **Mark conservatism** — don't mark up on your own follow-on price alone; don't let
  stale marks masquerade as current. Product form: marks carry basis + date, and
  staleness is *visible* (last-mark-date column in the portfolio table).

## 9. What each surveyed product actually is *(one line each, against this glossary)*

- **Carta** — §5 as the legal system of record, plus §7 fund admin as a service.
- **Fundwave** — §2 + §7 productized: allocations, capital accounts, notices,
  waterfalls, NAV statements, LP portal. The deepest *accounting* engine of the set.
- **TagHash** — §6 at fund-ops depth (50+ metrics, valuation workflows, look-through)
  with §2 capital activity; India-strong.
- **Totem** — §6 with AI dressing: tear sheets, automated IRR, Carta ingestion, LP
  reporting. "The AI fund operating system."
- **Edda** — §3 + §6 bridged: scorecard-driven dealflow that auto-hands-off to
  portfolio; founder data requests; deck reader.
- **Affinity** — §3 alone, at maximum depth: the relationship graph as the product.
- **Visible** — §6's MIS slice alone: founder updates + standard-six metrics.
- **Us** — §3 + §4 + §5(our-position) + §6-gross, self-hosted, on one graph with the
  research half none of them have; §2 and §7 fenced until a fund-I customer drags a
  lightweight capital ledger into scope.

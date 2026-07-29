# Deals are an object, not list entries

CONTEXT.md originally borrowed Attio's list/entry primitive as the deal mechanism: pipeline
state would live on list membership, and "deal" would not exist as a record type. Reversed
2026-07: **Deal is a first-class object** — one record per investment opportunity per
company, born at Pre-lead, terminal at Invested/Passed/Lost — because that matches the
mental model of the individual investor we design for, kanban falls out of a status
attribute instead of requiring a list engine, and per-opportunity records preserve pass/loss
reasoning across years ("why did we pass in 2024?"), which membership rows model poorly.

The list/entry tables stay in the schema for possible watchlist/portfolio use, but nothing
waits on them. Watching-without-a-deal is deliberately *not* a deal stage — it lives in
spaces tagging ("tracking, not evaluating"); real funds' data showed "Tracking" as a
pipeline stage is a workaround for tools that lack a research layer.

## Considered options

- **List/entry model (original):** same company in many lists with different fields —
  strictly more flexible, but the flexibility served multi-pipeline funds, not the
  single-funnel angel; and every deal feature would have waited on the list engine.
- **Deal object (chosen):** simpler to build, simpler to explain, richer history.

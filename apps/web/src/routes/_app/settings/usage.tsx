import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SettingsSection } from '#/components/settings/settings-section'
import { SUGGESTION_KIND_WORD } from '#/components/inbox/suggestion-card'
import { formatNumber } from '@spaces/core/format'
import { getAiRun, getAiUsage } from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

type UsageView = Awaited<ReturnType<typeof getAiUsage>>
type RunItem = UsageView['runs'][number]
type LoneCall = UsageView['loneCalls'][number]
type RunDetail = NonNullable<Awaited<ReturnType<typeof getAiRun>>>
type RunStep = RunDetail['steps'][number]

/**
 * Settings → AI usage (SPA-100, `docs/spec-ai-substrate.md` §6): the run log.
 * Every AI action is one `ai_run` — its task, the record it was about, who
 * started it, its status and what it cost — newest first; opening one
 * (`?run=<id>`, which the inbox's "produced by this run" links to) lists its
 * steps in order: the lane it ran on, the model, the tokens, and
 * `input_refs → output_ref` resolved to names server-side through
 * `cite.ts`. Calls no run owns — the settings Test call — list apart, under
 * "Calls outside a run".
 *
 * Its own section rather than a block of `ai.tsx`, because the settings
 * shell's grammar is one row per section and one file per row
 * (`docs/design-contract.md` §3, which names Usage). Not admin-only, unlike
 * AI providers: it writes nothing, it is the provenance a suggestion in the
 * inbox links every member to, and it reads only what the inbox already
 * shows them. The ledgers take the API tokens table's shape.
 */
export const Route = createFileRoute('/_app/settings/usage')({
  validateSearch: z.object({ run: z.string().uuid().optional() }),
  loaderDeps: ({ search }) => ({ run: search.run ?? null }),
  loader: async ({ deps }) => {
    const [usage, run] = await Promise.all([
      getAiUsage(),
      deps.run === null
        ? Promise.resolve(null)
        : getAiRun({ data: { runId: deps.run } }),
    ])
    return { usage, run, asked: deps.run }
  },
  component: UsageRoute,
})

/** An ISO instant as the ledger prints it: `2026-09-23 14:02 UTC`, no locale. */
function stamp(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—'
}

/** `1,204 / 312`; a side the provider did not report reads `—`. */
function tokens(tokensIn: number | null, tokensOut: number | null): string {
  if (tokensIn === null && tokensOut === null) return '—'
  const side = (n: number | null) => (n === null ? '—' : formatNumber(n))
  return `${side(tokensIn)} / ${side(tokensOut)}`
}

function UsageRoute() {
  const { usage, run, asked } = Route.useLoaderData()
  const spent = usage.runs.reduce(
    (sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
    0,
  )
  return (
    <SettingsSection
      title="AI usage"
      blurb="Every AI action as a run: what it read, which models it called, what it cost and what it proposed."
      crumb="Data & AI"
    >
      <div className="flex flex-col pt-5">
        <div className="flex items-baseline gap-3 pb-2">
          <h3 className="label-caps text-foreground">Runs</h3>
          <span className="mono text-micro text-graphite">
            {usage.runs.length} listed · {formatNumber(spent)} tokens
          </span>
        </div>
        <div className="flex h-8 items-center gap-3 border-y border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Task</span>
          <span className="w-36 shrink-0">Record</span>
          <span className="w-28 shrink-0">Who</span>
          <span className="w-36 shrink-0">Started</span>
          <span className="w-16 shrink-0">Status</span>
          <span className="w-28 shrink-0 text-right">Tokens in / out</span>
          <span className="w-36 shrink-0 text-right">Suggestions</span>
        </div>
        {usage.runs.length === 0 ? (
          <p className="border-b border-rule py-3 text-label text-graphite">
            No runs yet. Read a deck, summarize a document or suggest spaces,
            and each shows here as one run.
          </p>
        ) : (
          usage.runs.map((r) => (
            <RunRow key={r.id} run={r} open={r.id === asked} />
          ))
        )}
      </div>

      {asked === null ? null : run === null ? (
        <p className="mt-5 border-y border-rule py-3 text-label text-graphite">
          That run is not in the log.
        </p>
      ) : (
        <RunPanel detail={run} />
      )}

      <LoneCalls calls={usage.loneCalls} />
    </SettingsSection>
  )
}

function StatusWord({ status }: { status: RunItem['status'] }) {
  return (
    <span
      className={cn(
        'w-16 shrink-0 mono text-micro',
        status === 'failed'
          ? 'text-destructive'
          : status === 'running'
            ? 'text-graphite'
            : 'text-foreground',
      )}
    >
      {status}
    </span>
  )
}

function RunRow({ run, open }: { run: RunItem; open: boolean }) {
  const { open: waiting, accepted, rejected } = run.suggestions
  const produced = waiting + accepted + rejected
  return (
    <Link
      to="/settings/usage"
      search={open ? {} : { run: run.id }}
      aria-current={open ? 'true' : undefined}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-3 border-b border-rule hover:bg-bone',
        open && 'bg-bone',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-ui font-medium">
        {run.task}
        <span className="ml-2 mono text-micro font-normal text-graphite">
          {run.steps} step{run.steps === 1 ? '' : 's'}
        </span>
      </span>
      <span className="w-36 shrink-0 truncate text-label">
        {run.record?.name ?? '—'}
      </span>
      <span className="w-28 shrink-0 truncate text-label text-graphite">
        {run.who}
      </span>
      <span className="w-36 shrink-0 mono text-micro text-graphite">
        {stamp(run.startedAt)}
      </span>
      <StatusWord status={run.status} />
      <span className="w-28 shrink-0 numeric text-right text-micro">
        {tokens(run.tokensIn, run.tokensOut)}
      </span>
      <span className="w-36 shrink-0 text-right mono text-micro text-graphite">
        {produced === 0 ? '—' : `${waiting} open · ${accepted} accepted`}
      </span>
    </Link>
  )
}

/** One run opened: its readout, its steps in order, what it proposed. */
function RunPanel({ detail }: { detail: RunDetail }) {
  const { run } = detail
  const href = run.record ? recordPath(run.record) : null
  return (
    <div className="mt-5 flex flex-col border border-rule">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule bg-bone px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="label-caps text-foreground">Run · {run.task}</h3>
          <span className="truncate mono text-micro text-graphite">
            {run.who} · {stamp(run.startedAt)}
            {run.finishedAt ? ` → ${stamp(run.finishedAt)}` : ' · unfinished'}
          </span>
        </div>
        <Link
          to="/settings/usage"
          search={{}}
          className="focus-ring shrink-0 mono text-micro text-graphite hover:text-foreground"
        >
          close
        </Link>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule px-3 py-2 text-label">
        <span>
          <span className="text-graphite">Record </span>
          {run.record === null ? (
            '—'
          ) : href ? (
            <a href={href} className="focus-ring hover:underline">
              {run.record.name}
            </a>
          ) : (
            run.record.name
          )}
        </span>
        <span>
          <span className="text-graphite">Status </span>
          <span
            className={cn(
              run.status === 'failed' && 'text-destructive',
              run.status === 'running' && 'text-graphite',
            )}
          >
            {run.status}
          </span>
        </span>
        <span>
          <span className="text-graphite">Tokens </span>
          <span className="numeric">{tokens(run.tokensIn, run.tokensOut)}</span>
        </span>
        <span>
          <span className="text-graphite">Calls </span>
          <span className="numeric">{detail.calls}</span>
        </span>
      </div>
      {run.error === null ? null : (
        <p
          role="alert"
          className="border-b border-rule px-3 py-2 text-label text-destructive"
        >
          {run.error}
        </p>
      )}
      {run.status === 'running' ? (
        <p className="border-b border-rule px-3 py-2 text-label text-graphite">
          Still running — or its process stopped before it could finish, in
          which case it stays here as it was left.
        </p>
      ) : null}

      <div className="flex h-8 items-center gap-3 border-b border-hairline px-3 field-label leading-4 text-graphite">
        <span className="w-6 shrink-0">#</span>
        <span className="w-20 shrink-0">Tool</span>
        <span className="w-40 shrink-0">Model</span>
        <span className="w-28 shrink-0 text-right">Tokens in / out</span>
        <span className="min-w-0 flex-1">Input refs → output ref</span>
      </div>
      {detail.steps.length === 0 ? (
        <p className="border-b border-rule px-3 py-3 text-label text-graphite">
          No step finished.
        </p>
      ) : (
        detail.steps.map((step, i) => (
          <StepRow key={`${step.at}-${i}`} step={step} index={i + 1} />
        ))
      )}

      <div className="flex h-8 items-center gap-3 border-b border-hairline px-3 field-label leading-4 text-graphite">
        <span className="min-w-0 flex-1">Suggestions it produced</span>
        <span className="w-20 shrink-0 text-right">Status</span>
      </div>
      {detail.suggestions.length === 0 ? (
        <p className="px-3 py-3 text-label text-graphite">None.</p>
      ) : (
        detail.suggestions.map((s) => (
          <div
            key={s.id}
            className="flex h-9 items-center gap-3 border-b border-rule px-3 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate text-ui">
              {SUGGESTION_KIND_WORD[s.kind]}
              <span className="text-graphite"> on </span>
              {s.record.name}
            </span>
            <span
              className={cn(
                'w-20 shrink-0 text-right mono text-micro',
                s.status === 'open' ? 'text-foreground' : 'text-graphite',
              )}
            >
              {s.status}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

/** A step's output, in words: the suggestion it wrote, or the ref it named. */
function outputLabel(output: RunStep['output']): string {
  if (output === null) return 'nothing proposed'
  switch (output.kind) {
    case 'suggestion':
      return `${SUGGESTION_KIND_WORD[output.suggestionKind]} on ${output.record} · ${output.status}`
    case 'ref':
      return output.resolved.label
    case 'missing':
      return 'no longer here'
  }
}

function StepRow({ step, index }: { step: RunStep; index: number }) {
  return (
    <div className="flex items-start gap-3 border-b border-rule px-3 py-2">
      <span className="w-6 shrink-0 numeric text-micro text-graphite">
        {index}
      </span>
      <span className="w-20 shrink-0 mono text-micro">{step.tool}</span>
      <span className="flex w-40 shrink-0 flex-col">
        <span className="truncate mono text-micro">{step.model ?? '—'}</span>
        {step.cached ? (
          <span className="mono text-micro text-graphite">
            cached · no call
          </span>
        ) : null}
      </span>
      <span className="w-28 shrink-0 numeric text-right text-micro">
        {tokens(step.tokensIn, step.tokensOut)}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {step.inputs.length === 0 ? (
          <span className="mono text-micro text-graphite">no refs</span>
        ) : (
          step.inputs.map((r) => (
            <span
              key={r.ref}
              title={r.ref}
              className={cn(
                'max-w-full truncate border border-rule bg-paper px-1.5 py-0.5 mono text-micro text-graphite',
                r.missing && 'italic',
              )}
            >
              {r.label}
            </span>
          ))
        )}
        <span className="px-1 mono text-micro text-graphite">→</span>
        <span
          title={step.output?.ref}
          className={cn(
            'max-w-full truncate border border-rule px-1.5 py-0.5 mono text-micro',
            step.output === null
              ? 'bg-paper text-graphite'
              : 'bg-bone text-foreground',
          )}
        >
          {outputLabel(step.output)}
        </span>
      </div>
    </div>
  )
}

function LoneCalls({ calls }: { calls: ReadonlyArray<LoneCall> }) {
  return (
    <div className="flex flex-col pt-8">
      <div className="flex items-baseline gap-3 pb-2">
        <h3 className="label-caps text-foreground">Calls outside a run</h3>
        <span className="mono text-micro text-graphite">
          {calls.length} · the settings Test call
        </span>
      </div>
      <div className="flex h-8 items-center gap-3 border-y border-hairline field-label leading-4 text-graphite">
        <span className="w-20 shrink-0">Lane</span>
        <span className="min-w-0 flex-1">Provider · model</span>
        <span className="w-28 shrink-0">Who</span>
        <span className="w-36 shrink-0">At</span>
        <span className="w-28 shrink-0 text-right">Tokens in / out</span>
      </div>
      {calls.length === 0 ? (
        <p className="border-b border-rule py-3 text-label text-graphite">
          None — every call so far was a step of a run.
        </p>
      ) : (
        calls.map((c) => (
          <div
            key={c.id}
            className="flex h-9 items-center gap-3 border-b border-rule"
          >
            <span className="w-20 shrink-0 mono text-micro">{c.lane}</span>
            <span className="min-w-0 flex-1 truncate mono text-micro">
              {c.provider} · {c.model}
            </span>
            <span className="w-28 shrink-0 truncate text-label text-graphite">
              {c.who}
            </span>
            <span className="w-36 shrink-0 mono text-micro text-graphite">
              {stamp(c.at)}
            </span>
            <span className="w-28 shrink-0 numeric text-right text-micro">
              {tokens(c.tokensIn, c.tokensOut)}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

import { useRouter } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AI_MODE_LABEL,
  aiModesFor,
  readAiConfig,
} from '@spaces/core/ai/attribute-ai'
import type { AiAttributeMode } from '@spaces/core/ai/attribute-ai'
import { Button } from '#/components/ui/button'
import { Segmented } from '#/components/ui/segmented'
import { updateAttribute } from '#/lib/server-fns'
import { TYPE_LABELS } from './registry-list'
import type { RegistryAttr } from './registry-list'

/**
 * AI attributes (SPA-72, spec-ai-substrate §13) — the per-object config
 * panel. The spec's `attribute.config.ai` is stored as `attribute.options.ai`
 * (there is no `config` column), written through `updateAttribute`'s
 * `config.ai`, the same door as a currency code or a rating's max.
 *
 * **The panel offers only the modes the type can hold**
 * (`aiModesFor`, `@spaces/core/ai/attribute-ai`): Classify on a select,
 * multi-select, status or checkbox; Summarize, Prompt or Research on text;
 * Prompt on a number, amount or date; Research on a URL or domain. An
 * attribute whose type holds none is not listed. The program refuses the
 * rest anyway; the panel just never offers them.
 *
 * Laid out as the Identity keys ledger below the registry: a caps head on a
 * hairline, one row per attribute on a rule, the editor opening under its
 * row. Reshaping is admin-owned, like every other attribute setting.
 */

const MODE_HINT: Record<AiAttributeMode, string> = {
  classify: 'picks one of the options — a new one is proposed, never added',
  summarize: 'writes a short summary of what the record’s context says',
  prompt: 'answers your prompt in this field’s type',
  research: 'answers from the research lane',
}

export function AiConfigSection({
  objectPlural,
  registry,
  canReshape,
}: {
  objectPlural: string
  registry: Array<RegistryAttr>
  canReshape: boolean
}) {
  const eligible = registry.filter(
    (a) => !a.archived && aiModesFor(a.type).length > 0,
  )
  const [open, setOpen] = useState<string | null>(null)
  const configured = eligible.filter((a) => readAiConfig(a) !== null).length
  if (eligible.length === 0) return null
  return (
    <section className="mt-8 flex flex-col">
      <div
        aria-hidden
        className="flex h-8 items-center gap-3 border-b border-hairline label-caps text-graphite"
      >
        <span className="min-w-0 flex-1">AI attributes</span>
        <span className="mono text-micro">{configured} configured</span>
      </div>
      <ul aria-label={`${objectPlural} AI attributes`}>
        {eligible.map((attr) => {
          const ai = readAiConfig(attr)
          return (
            <li key={attr.id} className="flex flex-col border-b border-rule">
              <div className="flex h-row items-center gap-3 text-ui">
                <span className="min-w-0 flex-1 truncate">{attr.name}</span>
                <span className="mono text-micro text-graphite">
                  {TYPE_LABELS[attr.type] ?? attr.type}
                </span>
                <span className="w-24 shrink-0 text-label text-graphite">
                  {ai === null ? (
                    'off'
                  ) : (
                    <span className="flex items-center gap-1 text-foreground">
                      <Sparkles className="size-3" strokeWidth={1.75} />
                      {AI_MODE_LABEL[ai.mode]}
                    </span>
                  )}
                </span>
                {canReshape ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={open === attr.id}
                    onClick={() =>
                      setOpen((o) => (o === attr.id ? null : attr.id))
                    }
                  >
                    {open === attr.id ? 'Close' : 'Configure'}
                  </Button>
                ) : null}
              </div>
              {open === attr.id ? (
                <AiConfigEditor
                  attr={attr}
                  registry={registry}
                  onDone={() => setOpen(null)}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="flex h-8 items-center mono text-micro text-graphite">
        manual, per cell · every answer lands in the inbox as a suggestion ·
        types are unchanged
      </p>
    </section>
  )
}

function AiConfigEditor({
  attr,
  registry,
  onDone,
}: {
  attr: RegistryAttr
  registry: Array<RegistryAttr>
  onDone: () => void
}) {
  const router = useRouter()
  const modes = aiModesFor(attr.type)
  const stored = readAiConfig(attr)
  const [mode, setMode] = useState<AiAttributeMode>(
    stored?.mode ?? modes.at(0) ?? 'prompt',
  )
  const [prompt, setPrompt] = useState(stored?.prompt ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = registry.filter((a) => !a.archived && a.id !== attr.id)

  async function save(ai: { mode: AiAttributeMode; prompt: string } | null) {
    setPending(true)
    setError(null)
    try {
      await updateAttribute({ data: { id: attr.id, config: { ai } } })
      toast(
        ai === null
          ? `${attr.name} is no longer an AI attribute`
          : `${attr.name} · ${AI_MODE_LABEL[ai.mode]} saved`,
      )
      onDone()
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 pb-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save({ mode, prompt })
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={`${attr.name} mode`}
          size="sm"
          value={mode}
          options={modes.map((m) => ({ id: m, label: AI_MODE_LABEL[m] }))}
          onChange={setMode}
        />
        <span className="text-label text-graphite">{MODE_HINT[mode]}</span>
      </div>
      <textarea
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={
          mode === 'classify'
            ? 'Optional guidance — what separates one option from another.'
            : 'What to ask. Name another field with {{slug}}.'
        }
        aria-label={`${attr.name} prompt`}
        className="focus-ring w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-ui outline-none placeholder:text-graphite"
      />
      {others.length > 0 ? (
        <p className="mono text-micro text-graphite">
          variables:{' '}
          {others
            .slice(0, 12)
            .map((a) => `{{${a.slug}}}`)
            .join(' ')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-label text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {stored ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => void save(null)}
          >
            Turn off
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  )
}

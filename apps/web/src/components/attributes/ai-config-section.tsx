import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AI_MODE_LABEL,
  aiModesFor,
  readAiConfig,
} from '@spaces/core/ai/attribute-ai'
import type { AiAttributeMode } from '@spaces/core/ai/attribute-ai'
import { SettingsGroupHead } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import { updateAttribute } from '#/lib/server-fns'
import type { RegistryAttr } from './registry-list'

/**
 * AI answers — the per-object config, listing only the attributes that
 * answer with AI. Stored as `attribute.options.ai`, written through
 * `updateAttribute`'s `config.ai`, the same door as a currency code or a
 * rating's max.
 * - `+ Add` offers the rest of the attributes whose type can hold a mode
 *   (`aiModesFor`); the editor opens under its row. One the type holds
 *   none of is never offered, and the program refuses it anyway.
 * - Reshaping is admin-owned, like every other attribute setting.
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
  const configured = eligible.filter((a) => readAiConfig(a) !== null)
  const offered = eligible.filter((a) => readAiConfig(a) === null)
  if (eligible.length === 0) return null
  // The attribute being set up is listed while its editor is open.
  const listed = eligible.filter(
    (a) => readAiConfig(a) !== null || a.id === open,
  )
  return (
    <section className="flex flex-col">
      <SettingsGroupHead
        title="AI answers"
        count={`${configured.length} set`}
        action={
          canReshape && offered.length > 0 ? (
            <Select
              aria-label={`Add an AI answer to ${objectPlural}`}
              value=""
              placeholder="+ Add"
              items={offered.map((a) => ({ value: a.id, label: a.name }))}
              onChange={(id) => setOpen(id)}
              width="content"
              className="h-6 w-auto rounded-none border-0 bg-transparent px-1 mono text-micro text-graphite hover:text-foreground"
            />
          ) : undefined
        }
      />
      {listed.length === 0 ? (
        <p className="border-b border-rule py-3 text-label text-graphite">
          No attribute answers with AI.
        </p>
      ) : (
        <ul aria-label={`${objectPlural} AI answers`}>
          {listed.map((attr) => {
            const ai = readAiConfig(attr)
            return (
              <li key={attr.id} className="flex flex-col border-b border-rule">
                <div className="flex h-ledger-row items-center gap-3 text-ui">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {attr.name}
                  </span>
                  <span className="w-24 shrink-0 mono text-micro text-graphite">
                    {ai === null ? 'not set' : AI_MODE_LABEL[ai.mode]}
                  </span>
                  {canReshape ? (
                    <Button
                      size="sm"
                      variant="outline"
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
      )}
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

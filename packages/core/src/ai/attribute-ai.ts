import { z } from 'zod'
import type {
  AiAttributeConfig,
  AiAttributeMode,
} from '@spaces/db/schema/attributes'
import type { AttributeType } from '../attributes/registry'

/**
 * AI attributes (SPA-72, docs/spec-ai-substrate.md §13) — the pure half.
 *
 * **The spec's `attribute.config.ai` is the code's `attribute.options.ai`.**
 * There is no `config` column: the per-type blob is `attribute.options`
 * jsonb, so `options.ai = {mode, prompt, variables?, lane}` is the spec's
 * `config.ai` under its real name (`AiAttributeConfig`,
 * `packages/db/src/schema/attributes.ts`). Config on the existing types, not
 * new types: nothing here names an object, so a custom object's attribute
 * gets the affordance the moment its type can hold a mode.
 *
 * What lives here: the mode × type matrix the config panel and the update
 * program both read, the mode → lane map, the config's decoder, the
 * `{{slug}}` variable grammar, and the rationale line that carries a
 * proposed new select option (a registry proposal — never a value, never a
 * silent new option).
 */

export type { AiAttributeConfig, AiAttributeMode }

export const AI_ATTRIBUTE_MODES = [
  'classify',
  'summarize',
  'prompt',
  'research',
] as const satisfies ReadonlyArray<AiAttributeMode>

export type AiAttributeLane = AiAttributeConfig['lane']

/**
 * Which types each mode can write. `classify` picks from a vocabulary the
 * type already has (options, or yes/no); `summarize` writes prose; `prompt`
 * answers in the type's own write shape; `research` brings back a line of
 * text or a link. Every other type — email, phone, rating, the two
 * references — holds no mode: a model does not assign an owner, dial a
 * number or claim a record from a cell.
 */
export const AI_MODE_TYPES: Record<
  AiAttributeMode,
  ReadonlyArray<AttributeType>
> = {
  classify: ['select', 'multi_select', 'status', 'checkbox'],
  summarize: ['text'],
  prompt: ['text', 'number', 'currency', 'date'],
  research: ['text', 'url', 'domain'],
}

/** The lane a mode runs on — never chosen per attribute. */
export const AI_MODE_LANE: Record<AiAttributeMode, AiAttributeLane> = {
  classify: 'classify',
  summarize: 'synthesize',
  prompt: 'synthesize',
  research: 'research',
}

export const AI_MODE_LABEL: Record<AiAttributeMode, string> = {
  classify: 'Classify',
  summarize: 'Summarize',
  prompt: 'Prompt',
  research: 'Research',
}

/** The modes an attribute of this type can hold, in menu order. */
export function aiModesFor(type: string): Array<AiAttributeMode> {
  return AI_ATTRIBUTE_MODES.filter((m) =>
    AI_MODE_TYPES[m].some((t) => t === type),
  )
}

export function aiModeFits(mode: AiAttributeMode, type: string): boolean {
  return aiModesFor(type).includes(mode)
}

/** `{{slug}}` — a variable the prompt reads off the record. */
const VARIABLE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g

/** The distinct slugs a prompt names, in first-seen order. */
export function promptVariables(prompt: string): Array<string> {
  return [...new Set([...prompt.matchAll(VARIABLE)].map((m) => m[1]))]
}

/**
 * The prompt with each `{{slug}}` replaced by the record's value for it; a
 * slug with no value reads `(blank)` so the model is told, not left guessing.
 */
export function renderAiPrompt(
  prompt: string,
  values: Readonly<Record<string, string>>,
): string {
  return prompt.replace(
    VARIABLE,
    (_, slug: string) => values[slug] ?? '(blank)',
  )
}

/** The config panel's write, as the update boundary decodes it. */
export const aiConfigInput = z.object({
  mode: z.enum(AI_ATTRIBUTE_MODES),
  prompt: z.string().trim().max(2000),
})
export type AiConfigInput = z.infer<typeof aiConfigInput>

/**
 * The stored shape, read leniently: a row written before a mode was
 * renamed, or by hand, decodes to null rather than to a half-config.
 */
const storedConfig = z.object({
  mode: z.enum(AI_ATTRIBUTE_MODES),
  prompt: z.string(),
  variables: z.array(z.string()).optional(),
  lane: z.enum(['classify', 'synthesize', 'research']),
})

/** The attribute's AI config, or null when it has none it can run. */
export function readAiConfig(def: {
  type: string
  options: { ai?: unknown } | null
}): AiAttributeConfig | null {
  const parsed = storedConfig.safeParse(def.options?.ai)
  if (!parsed.success) return null
  if (!aiModeFits(parsed.data.mode, def.type)) return null
  const { mode, prompt, variables } = parsed.data
  return variables === undefined
    ? { mode, prompt, lane: AI_MODE_LANE[mode] }
    : { mode, prompt, variables, lane: AI_MODE_LANE[mode] }
}

/**
 * Input → the stored config: the lane written from the mode and the
 * variables read off the prompt against the slugs the object has, so
 * neither is a second opinion that could disagree. Null with a reason when
 * the type cannot hold the mode.
 */
export function buildAiConfig(
  type: string,
  input: AiConfigInput,
  slugs: ReadonlyArray<string>,
): { ok: true; config: AiAttributeConfig } | { ok: false; message: string } {
  if (!aiModeFits(input.mode, type))
    return {
      ok: false,
      message: `${AI_MODE_LABEL[input.mode]} is not a mode a ${type} attribute can hold`,
    }
  const known = new Set(slugs)
  const named = promptVariables(input.prompt)
  const unknown = named.filter((s) => !known.has(s))
  if (unknown.length > 0)
    return {
      ok: false,
      message: `The prompt names ${unknown.map((s) => `{{${s}}}`).join(', ')}, which ${unknown.length === 1 ? 'is not an attribute' : 'are not attributes'} of this object`,
    }
  const config: AiAttributeConfig = {
    mode: input.mode,
    prompt: input.prompt,
    lane: AI_MODE_LANE[input.mode],
  }
  return named.length > 0
    ? { ok: true, config: { ...config, variables: named } }
    : { ok: true, config }
}

// ---------- the registry proposal (a new option, never a value) ----------

/**
 * A classify answer naming an option the attribute does not have becomes a
 * registry proposal: a suggestion whose patch is empty and whose rationale
 * opens with this line. The inbox card reads it back and offers "Add option"
 * through the attribute's existing option-list edit; the cell reads it to
 * show "proposed". One grammar, written and read here, so the writer and
 * the two readers cannot drift.
 */
export type OptionProposal = {
  /** The attribute's slug — immutable, so it still names it later. */
  slug: string
  /** The attribute's name when proposed, for the card's sentence. */
  name: string
  /** The option label the model wanted. */
  label: string
}

export function optionProposalLine(p: OptionProposal): string {
  return `Proposed new option ${JSON.stringify(p.label)} for ${p.name} (${p.slug}).`
}

const LINE =
  /^Proposed new option ("(?:[^"\\]|\\.)*") for (.+) \(([a-z0-9_]+)\)\.$/gm

/** Every option proposal a rationale carries, in order. */
export function readOptionProposals(
  rationale: string | null,
): Array<OptionProposal> {
  if (rationale === null) return []
  const out: Array<OptionProposal> = []
  for (const m of rationale.matchAll(LINE)) {
    const label = z.string().safeParse(safeJson(m[1]))
    if (label.success) out.push({ label: label.data, name: m[2], slug: m[3] })
  }
  return out
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The longest option label the option-list edit accepts. */
export const OPTION_LABEL_MAX = 60

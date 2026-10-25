import { PROVIDER_LABEL } from './providers/ids'
import type { SensitivityVia } from './sensitivity'

/**
 * The words a streamed answer is footed with: which model answered, whether
 * the sensitivity gate sent it local, or why it was refused. Prep and Ask
 * both print these, so they are spelled once.
 */

export const providerLabel = (provider: string): string =>
  Object.entries(PROVIDER_LABEL).find(([id]) => id === provider)?.[1] ??
  provider

/** Where a sensitive call's sensitivity came from, as a parenthesis. */
const inherited = (via: SensitivityVia | null): string => {
  if (via === null) return ''
  switch (via.kind) {
    case 'own':
      return ''
    case 'space':
      return ` (inherited from ${via.name})`
    case 'binding':
      return ` (inherited from ${via.name ?? 'its storage binding'})`
    case 'default':
      return ' (the workspace default)'
  }
}

/** The line over a running answer: the model, or the local route it took. */
export function routeLine(
  target: { provider: string; model: string },
  sensitive: SensitivityVia | null,
  isSensitive: boolean,
): string {
  const label = providerLabel(target.provider)
  if (!isSensitive) return `${label} · ${target.model}`
  return `Sensitive${inherited(sensitive)} · answered locally by ${label} · ${target.model}`
}

/** A refusal, prefixed the way every streamed surface prints it. */
export const refusedLine = (sentence: string): string => `Refused · ${sentence}`

import { formatNumber } from '@spaces/core/format'
import { SCOPE_DROPPED } from './scope'
import type { AskCall, AskTurnState } from './types'

/**
 * The lines an answer prints about itself rather than its subject: the
 * notice row over a sensitive, capped or refused turn, the thinking line,
 * a stopped turn's count and the words a call's state reads as. Pure, so
 * the thread and its tests read one set of rules.
 */

export type AskNotice = {
  /** The 6px square: warning for a turn that still answered, else destructive. */
  tone: 'warning' | 'destructive'
  sentence: string
  link: { label: string; to: '/settings/models' | '/settings/usage' } | null
}

/** How the route line of a turn the gate sent local begins. */
const SENSITIVE_PREFIX = 'Sensitive'
/** What a sensitive route line says before the model that answered. */
const LOCAL_BY = 'answered locally by '

/** True when the route line says the sensitivity gate sent the turn local. */
export const isSensitiveRoute = (route: string | null): boolean =>
  route !== null && route.startsWith(SENSITIVE_PREFIX)

/** The route line's `Provider · model`, without the gate's preamble. */
export function modelLine(route: string | null): string | null {
  if (route === null || !isSensitiveRoute(route)) return route
  const at = route.indexOf(LOCAL_BY)
  return at < 0 ? route : route.slice(at + LOCAL_BY.length)
}

/** A cap refusal as its route line: what was spent, of what, and when it resets. */
export function capLine(cap: {
  kind: 'daily' | 'per_run'
  ceiling: number
  used: number
}): string {
  const n = (x: number) => formatNumber(x, 0)
  return cap.kind === 'daily'
    ? `Daily AI cap reached · ${n(cap.used)} of ${n(cap.ceiling)} tokens · resets 00:00 UTC`
    : `Per-run AI cap · ${n(cap.used)} tokens asked, ${n(cap.ceiling)} allowed`
}

/** The notice over a turn, from its state and route line; null for none. */
export function turnNotice(
  state: AskTurnState | null,
  route: string | null,
): AskNotice | null {
  if (state === 'capped')
    return {
      tone: 'destructive',
      sentence: route ?? 'Daily AI cap reached',
      link: { label: 'Usage ›', to: '/settings/usage' },
    }
  if (state === 'refused')
    return {
      tone: 'destructive',
      sentence: 'Sensitive space · nothing sent',
      link: { label: 'Add a local model ›', to: '/settings/models' },
    }
  if (isSensitiveRoute(route))
    return {
      tone: 'warning',
      sentence: 'Sensitive space in scope · answered on the local model',
      link: null,
    }
  return null
}

/** The calls a reader is shown: a dropped chip is a scope line, not a call. */
export const shownCalls = (
  calls: ReadonlyArray<AskCall>,
): ReadonlyArray<AskCall> => calls.filter((c) => c.tool !== SCOPE_DROPPED)

/**
 * What the answer is doing before its text arrives: reading while a call
 * runs or before any has, with what was found so far; computing once every
 * call has come back.
 */
export function thinkingWords(calls: ReadonlyArray<AskCall>): string {
  const shown = shownCalls(calls)
  const running = shown.some((c) => c.state === 'running')
  if (shown.length > 0 && !running) return 'Computing'
  const found = shown.reduce((sum, c) => sum + (c.found ?? 0), 0)
  if (found === 0) return 'Reading'
  return `Reading ${String(found)} ${found === 1 ? 'source' : 'sources'}`
}

/** A stopped turn: how many of its calls had come back. */
export function stoppedWords(calls: ReadonlyArray<AskCall>): string {
  const shown = shownCalls(calls)
  if (shown.length === 0) return 'Stopped'
  const done = shown.filter((c) => c.state === 'done').length
  return `Stopped · ${String(done)} of ${String(shown.length)} ${shown.length === 1 ? 'call' : 'calls'}`
}

/** A call's state as its strip prints it; a finished call says nothing. */
export const CALL_WORD: Record<AskCall['state'], string> = {
  running: 'Running',
  done: '',
  refused: 'Refused',
  failed: 'Failed',
  unmounted: 'Unmounted',
}

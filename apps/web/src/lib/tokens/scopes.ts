/**
 * What a personal token may do at the external API door (SPA-48), pinned
 * here and nowhere else. Deliberately tiny — the three external verbs the
 * integration map actually names:
 *
 * - `capture:write` — the capture extension posting a page (CONTEXT.md
 *   integration map #8; `/api/capture` is api-4's procedure).
 * - `records:read` — reading records through the API (#11).
 * - `suggestions:write` — reserved for an agent's proposals, so a future
 *   write verb reuses the one propose() door (ai-24) rather than opening its
 *   own.
 *
 * A scope widens nothing: every procedure still runs as the token's user,
 * canRead and all. A scope only narrows which procedures a token may call.
 *
 * Plain data with no server import: the settings page reads the same list it
 * offers as checkboxes.
 */
export const API_SCOPES = [
  'capture:write',
  'records:read',
  'suggestions:write',
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export function isApiScope(value: string): value is ApiScope {
  return API_SCOPES.some((scope) => scope === value)
}

/** What each scope lets a token do, as the settings form says it. */
export const API_SCOPE_HINTS: Record<ApiScope, string> = {
  'capture:write': 'Post captured pages from the browser extension',
  'records:read': 'Read records you can see',
  'suggestions:write': 'Propose changes to the inbox, never write them',
}

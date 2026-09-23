/**
 * `/tasks?task=<id>` — the row a Cmd-K hit lands on (CONTEXT.md 15b, "hits
 * route to /tasks with the row focused"). Open and Done are exclusive tabs,
 * so a focused task decides which one the page shows: a closed task opens
 * Done rather than rendering nothing. `null` — no param, or an id the
 * payload does not carry — leaves the tab alone and the page unfocused.
 */
export function focusTab(
  focus: string | undefined,
  data: {
    open: ReadonlyArray<{ id: string }>
    done: ReadonlyArray<{ id: string }>
  },
): 'open' | 'done' | null {
  if (focus === undefined) return null
  if (data.open.some((t) => t.id === focus)) return 'open'
  if (data.done.some((t) => t.id === focus)) return 'done'
  return null
}

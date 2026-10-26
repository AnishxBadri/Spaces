/**
 * Open tasks by due day, for the sidebar's `3 due`. The read hands back
 * days, and the shell counts them against its clock's `today`.
 */
export type DueDay = { readonly day: string; readonly n: number }

/** Open tasks due today or overdue, as of `today` (ISO, compared lexically). */
export const dueCount = (days: ReadonlyArray<DueDay>, today: string): number =>
  days.reduce((sum, d) => (d.day <= today ? sum + d.n : sum), 0)

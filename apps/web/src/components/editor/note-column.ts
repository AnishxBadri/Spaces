/**
 * The left inset of a page that holds a note editor: `--note-gutter` in
 * place of the page's usual 24px left edge — the one exception to it.
 * - The editor's side menu floats left of each block, so the inset has to
 *   hold it; at the page edge it reaches over the chassis.
 * - The columns that sit with the text wear it (a note's record head and
 *   body, the mandate's facts), so they keep one left edge. A `PageHeader`
 *   keeps the page's 24px edge.
 */
export const NOTE_INSET = 'pl-(--note-gutter)'

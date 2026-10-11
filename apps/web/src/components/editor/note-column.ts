/**
 * The left inset of a page that holds a note editor: `--note-gutter` in
 * place of the page's usual `px-8` left edge.
 * - The editor's side menu floats left of each block, so the inset has to
 *   hold it; at `px-8` it reaches over the chassis.
 * - The columns that sit with the text wear it (a note's title and filing
 *   rows, the mandate's facts), so they keep one left edge. A `PageHeader`
 *   keeps the page's 32px edge.
 */
export const NOTE_INSET = 'pl-(--note-gutter)'

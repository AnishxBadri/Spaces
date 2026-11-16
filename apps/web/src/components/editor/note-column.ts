/**
 * The left inset of a note editor inside its own sheet: `--note-gutter`,
 * the sheet's margin, where the side menu (`+` and the drag handle) floats
 * left of each block.
 * - Only the columns inside the sheet wear it (a note's body, the mandate's
 *   facts and prose). Every head stays on the page's 24px edge.
 * - Below `md` there is no hover to show the menu, and the gutter is 24px.
 */
export const NOTE_INSET = 'pl-(--note-gutter)'

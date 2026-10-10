/**
 * The left inset of a page that holds a note editor: `--note-gutter` in
 * place of the page's usual `px-8` left edge.
 * - The editor's side menu floats left of each block, so the inset has to
 *   hold it; at `px-8` it reaches over the chassis.
 * - Every column of the page wears it (head, filing rows, body), so the
 *   title and the text keep one left edge.
 */
export const NOTE_INSET = 'pl-(--note-gutter)'

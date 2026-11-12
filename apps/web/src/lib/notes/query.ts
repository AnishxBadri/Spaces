import { Effect, Schema } from 'effect'

/**
 * A failed read or write in a notes module. One class for the directory's
 * database calls, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class NotesQueryFailed extends Schema.TaggedError<NotesQueryFailed>()(
  'NotesQueryFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** An insert came back without the row it wrote. */
export class NoteRowMissing extends Schema.TaggedError<NoteRowMissing>()(
  'NoteRowMissing',
  { message: Schema.String },
) {}

/** The failure for a thrown cause. */
export const notesQueryFailed = (cause: unknown) =>
  new NotesQueryFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/** A database call inside a notes program. */
export const notesQuery = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: notesQueryFailed })

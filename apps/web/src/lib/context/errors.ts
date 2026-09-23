import { Schema } from 'effect'

/**
 * The assembler's tagged failures, in a module of their own so a lane file
 * (`similar.ts`) can raise them without importing the assembler that
 * imports it. `assemble.ts` re-exports all three; callers keep importing
 * them from there.
 */

export class ContextQueryFailed extends Schema.TaggedError<ContextQueryFailed>()(
  'ContextQueryFailed',
  { cause: Schema.Defect() },
) {}

export class ContextEntityNotFound extends Schema.TaggedError<ContextEntityNotFound>()(
  'ContextEntityNotFound',
  { id: Schema.String, message: Schema.String },
) {}

export class ContextLeak extends Schema.TaggedError<ContextLeak>()(
  'ContextLeak',
  { ref: Schema.String, message: Schema.String },
) {}

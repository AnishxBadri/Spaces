import { Schema } from 'effect'

/**
 * The assembler's tagged failures, in their own module so a lane can raise
 * them without importing the assembler that imports it. The assembler
 * re-exports all three.
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

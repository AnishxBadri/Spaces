/**
 * The closed JSON type every `jsonb()` column is typed against.
 * - Stored JSON gets its type once, at the column, and no reader re-asserts
 *   it (CLAUDE.md, principles).
 * - Closed rather than `unknown` because Start's serializer rejects `unknown`
 *   at the server-fn seam.
 * - The runtime narrowings (`jsonString`, `jsonRecord`, `jsonValue`) are
 *   readers, not columns: `@spaces/core/json`, which re-exports this type.
 */
export type Json =
  string | number | boolean | null | Array<Json> | { [k: string]: Json }

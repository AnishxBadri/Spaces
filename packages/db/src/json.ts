/**
 * The closed JSON type every `jsonb()` column is typed against. Stored JSON
 * is data crossing a boundary: it gets its type once, at the column, and no
 * reader re-asserts it (CLAUDE.md, principles). Closed rather than `unknown`
 * because Start's serializer rejects `unknown` at the server-fn seam.
 *
 * It lives here, and not in `apps/web/src/lib/json.ts`, because eight schema
 * files claim it and packages/db imports nothing internal (SPA-142). The
 * runtime narrowings that go with it — `jsonString`, `jsonRecord`,
 * `jsonValue` — are readers, not columns, and stayed in the app, which
 * re-exports this type so no caller's import changed.
 */
export type Json =
  string | number | boolean | null | Array<Json> | { [k: string]: Json }

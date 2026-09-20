/**
 * canRead, as a predicate. Policy is deliberately trivial (2026-08): shared
 * unless private-and-not-yours. Private applies to note bodies (and later
 * interaction bodies) only. The point of the choke point is that it exists
 * — every read path routes through it before any richer policy needs it.
 *
 * It lives here rather than in `lib/server/shared.ts` because it is pure and
 * every extracted helper outside `lib/server/` needs it: `shared.ts` imports
 * `getRequest`, so a module the client barrel can reach must not import it
 * (SPA-155). `shared.ts` re-exports this, so the server-fn modules keep
 * importing `canRead` from where they always did.
 */
export function canRead(
  user: { id: string },
  row: { visibility?: string | null; authorId?: string | null },
): boolean {
  if (row.visibility !== 'private') return true
  return row.authorId === user.id
}

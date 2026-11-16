import { createFileRoute, notFound } from '@tanstack/react-router'

/**
 * Any path no other route claims. Without it an unknown path matches only
 * the root, and its not-found screen stands outside the shell; claimed
 * here, it renders the router's default not-found inside the sidebar and
 * behind the shell's sign-in guard, like every other page.
 */
export const Route = createFileRoute('/_app/$')({
  loader: () => {
    throw notFound()
  },
})

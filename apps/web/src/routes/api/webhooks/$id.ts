import { createFileRoute } from '@tanstack/react-router'

/**
 * Webhook ingress. `$id` is the integration row's id,
 * not the plugin id: unguessable, and one per install. Answers only for an
 * enabled, running row whose stored manifest declares `ingress`; anything
 * else is the same 404 an unknown id gets.
 */
export const Route = createFileRoute('/api/webhooks/$id')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { handleWebhook } = await import('#/lib/integrations/ingress')
        return handleWebhook(request, params.id)
      },
    },
  },
})

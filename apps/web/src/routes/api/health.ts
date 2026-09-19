import { sql } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/db'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        try {
          await db.execute(sql`select 1`)
          return Response.json({ status: 'ok', db: 'ok' })
        } catch {
          return Response.json(
            { status: 'degraded', db: 'unreachable' },
            { status: 503 },
          )
        }
      },
    },
  },
})

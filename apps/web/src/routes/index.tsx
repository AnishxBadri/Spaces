import { createFileRoute, redirect } from '@tanstack/react-router'
import { getSession, getSetupState } from '#/lib/server-fns'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { needsSetup } = await getSetupState()
    if (needsSetup) throw redirect({ to: '/setup' })
    const session = await getSession()
    if (!session) throw redirect({ to: '/login' })
    throw redirect({ to: '/today' })
  },
})

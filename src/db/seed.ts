import { eq } from 'drizzle-orm'
import { db } from '#/db'
import { user } from '#/db/schema'

/**
 * Dev fixture runner — `pnpm db:seed`, the sibling of `db/migrate.ts`.
 *
 * Flags:
 *   --reset          wipe every record first (auth, workspace, and the
 *                    object/attribute registries survive)
 *   --user=<email>   whose name the fixtures are created under
 *                    (default: the first admin, else the first user)
 *   --bulk=<n>       extra filler companies for table behaviour at volume
 *
 * Never wired into boot: this is the developer's bench, not the operator's
 * demo. That one is `seedDemoData`, offered at setup.
 */
async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    args
      .find((a) => a.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=')
  const reset = args.includes('--reset')
  const bulk = Number(flag('bulk') ?? 0)
  const email = flag('user')

  const who = email
    ? (await db.select().from(user).where(eq(user.email, email))).at(0)
    : ((await db.select().from(user)).sort((a, b) =>
        a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1,
      )[0] ?? undefined)
  if (!who) {
    console.error(
      email
        ? `[seed] no user with email ${email}`
        : '[seed] no users yet — finish /setup first, then re-run',
    )
    process.exit(1)
  }

  const { resetDevData, seedDevData } = await import('#/lib/seeds/dev')
  if (reset) {
    console.log('[seed] --reset: truncating every record table')
    await resetDevData()
  }

  const summary = await seedDevData({ userId: who.id, bulk })
  const { partner, ...counts } = summary
  console.log(`[seed] as ${who.email}`)
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)
  console.log(
    partner.password
      ? `  second member: ${partner.email} / ${partner.password}`
      : `  second member: ${partner.email} (already existed)`,
  )
  console.log(
    '[seed] done. Meghdoot Edge holds SGD with no fx rate on purpose — the roll-up should show the gap, not a fake conversion.',
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed] failed', err)
  process.exit(1)
})

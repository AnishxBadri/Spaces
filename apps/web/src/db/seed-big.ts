/**
 * The volume bench's runner — `seedBigObject` against whatever
 * `DATABASE_URL` names.
 *
 *   DATABASE_URL=postgresql://…/spaces_spa64_test \
 *     corepack pnpm --filter @spaces/web exec tsx src/db/seed-big.ts --count=20000
 *
 * Flags:
 *   --count=<n>   records to insert (default 20000)
 *   --plural=<s>  the object's plural (default Funds)
 *   --force       write a database whose name does not look like a test one
 *
 * It refuses the dev `spaces` database by default on purpose: twenty
 * thousand fabricated funds in the database you demo from is not a mistake
 * you notice quickly.
 */
async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    args
      .find((a) => a.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=')

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('[seed:big] DATABASE_URL is unset')
    process.exit(1)
  }
  const dbName = url.split('/').at(-1)?.split('?')[0] ?? ''
  if (!dbName.includes('test') && !args.includes('--force')) {
    console.error(
      `[seed:big] refusing to write "${dbName}" — this seed is for a test database. Re-run with --force if you meant it.`,
    )
    process.exit(1)
  }

  const count = Number(flag('count') ?? 20_000)
  const plural = flag('plural') ?? 'Funds'
  const started = Date.now()
  const { seedBigObject } = await import('#/lib/seeds/big')
  const out = await seedBigObject({ count, plural })
  console.log(
    `[seed:big] ${out.created} records into /o/${out.objectSlug} on "${dbName}" in ${Math.round(
      (Date.now() - started) / 1000,
    )}s`,
  )
  console.log(`[seed:big] attribute slugs: ${out.slugs.join(', ')}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed:big] failed', err)
  process.exit(1)
})

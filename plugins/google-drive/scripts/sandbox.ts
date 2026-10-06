/**
 * The real-sandbox run: the storage-source conformance suite against a real
 * Google Drive, opt-in and never in CI's gates. A nightly job (the mono
 * area's to wire) runs it with a sandbox account's token; a failure is an
 * issue to open, not a blocked PR.
 *
 *   GOOGLE_DRIVE_SANDBOX_TOKEN=<access token, drive.readonly> \
 *   GOOGLE_DRIVE_SANDBOX_FIXTURE=<path to a fixture JSON> \
 *   corepack pnpm --filter @spaces/plugin-google-drive sandbox
 *
 * The fixture is `StorageSourceFixture` for the sandbox's own data room
 * (its folder and link, the child ids, a native Doc, ancestry chains, a
 * foreign link and a missing id), so the suite checks the real tree the
 * same way it checks the fake one. Without both variables it says so and
 * exits 0: an unconfigured nightly is not a red one.
 */
import { readFileSync } from 'node:fs'
import { Effect, Exit, Layer } from 'effect'
import { z } from 'zod'
import {
  HttpFetchTest,
  SecretsTest,
  storageSourceConformance,
} from '@spaces/sdk/testing'
import type { StorageSourceFixture } from '@spaces/sdk/testing'
import { driveSource } from '../src/drive.ts'

const fixtureSchema = z.object({
  dataRoom: z.object({
    folderId: z.string(),
    link: z.string(),
    childIds: z.array(z.string()),
  }),
  nativeDoc: z.object({
    fileId: z.string(),
    folderId: z.string(),
    link: z.string(),
    exportMime: z.string(),
  }),
  ancestry: z.array(
    z.object({ folderId: z.string(), ancestorIds: z.array(z.string()) }),
  ),
  foreignLink: z.string(),
  missingId: z.string(),
})

const token = process.env.GOOGLE_DRIVE_SANDBOX_TOKEN
const fixturePath = process.env.GOOGLE_DRIVE_SANDBOX_FIXTURE

const main = async (): Promise<number> => {
  if (token === undefined || fixturePath === undefined) {
    console.log(
      'google-drive sandbox: GOOGLE_DRIVE_SANDBOX_TOKEN and GOOGLE_DRIVE_SANDBOX_FIXTURE are not both set; nothing run',
    )
    return 0
  }
  const fixture: StorageSourceFixture = fixtureSchema.parse(
    JSON.parse(readFileSync(fixturePath, 'utf8')),
  )
  const ports = Layer.merge(
    HttpFetchTest((url, init) => fetch(url, init)).layer,
    SecretsTest({ accessToken: token }).layer,
  )
  const make = () => Effect.runSync(Effect.provide(driveSource, ports))
  let failed = 0
  for (const { name, run } of storageSourceConformance({
    make,
    fixture,
    secrets: [token],
  })) {
    const exit = await Effect.runPromiseExit(run)
    if (Exit.isSuccess(exit)) console.log(`ok    ${name}`)
    else {
      failed++
      console.log(`FAIL  ${name}\n      ${String(exit.cause)}`)
    }
  }
  console.log(`google-drive sandbox: ${failed} failed`)
  return failed === 0 ? 0 : 1
}

process.exitCode = await main()

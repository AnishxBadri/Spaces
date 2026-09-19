import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { company, document, entity, link, user } from '@spaces/db/schema'
import { resolveSecret, storeCredential } from '#/lib/vault'

/**
 * The backup round trip's fixture, run inside the app container by the
 * `roundtrip` CI job (`.github/workflows/ci.yml`) — never by the app.
 *
 * `plant` puts one of each thing a restore has to bring back: a document row
 * naming a blob that is already in ./data, and a credential encrypted under
 * ./data/secret.key. `verify` reads both back after the restore — the
 * document through the same join the Files tab uses (listRecordDocuments in
 * src/lib/server/documents.ts, minus the session check a script has no way
 * to hold), the credential through the real vault, so a secret.key that came
 * back wrong fails here rather than silently returning null.
 *
 *   tsx apps/web/scripts/roundtrip-fixture.ts plant  --blob=<sha256> --size=<bytes> --secret=<s>
 *   tsx apps/web/scripts/roundtrip-fixture.ts verify --blob=<sha256> --secret=<s>
 */

const FIXTURE = {
  userId: 'roundtrip-fixture-user',
  email: 'roundtrip@spaces.test',
  companyName: 'Round Trip Holdings',
  filename: 'roundtrip-deck.pdf',
  provider: 'roundtrip-fixture',
} as const

function arg(name: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!found) throw new Error(`[fixture] --${name}=… is required`)
  return found.slice(`--${name}=`.length)
}

async function plant() {
  const blobSha = arg('blob')
  const sizeBytes = Number(arg('size'))
  const secret = arg('secret')

  await db
    .insert(user)
    .values({
      id: FIXTURE.userId,
      name: 'Round Trip',
      email: FIXTURE.email,
      emailVerified: true,
      role: 'admin',
    })
    .onConflictDoNothing()

  const [record] = await db
    .insert(entity)
    .values({
      kind: 'company',
      canonicalName: FIXTURE.companyName,
      createdBy: FIXTURE.userId,
    })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: record.id })

  const [doc] = await db
    .insert(entity)
    .values({
      kind: 'document',
      canonicalName: FIXTURE.filename,
      createdBy: FIXTURE.userId,
    })
    .returning({ id: entity.id })
  await db.insert(document).values({
    entityId: doc.id,
    blobSha,
    filename: FIXTURE.filename,
    mime: 'application/pdf',
    sizeBytes,
    kind: 'deck',
    sourceClass: 'manual',
    uploadedBy: FIXTURE.userId,
  })
  await db.insert(link).values({
    fromEntityId: doc.id,
    toEntityId: record.id,
    relation: 'tagged_in',
    source: 'manual',
    createdBy: FIXTURE.userId,
  })

  const stored = await storeCredential({
    scope: 'workspace',
    provider: FIXTURE.provider,
    kind: 'llm',
    secret,
    createdBy: FIXTURE.userId,
  })

  console.log(
    `[fixture] planted: record ${record.id}, document ${doc.id} → blob ${blobSha}, credential ${stored.display}`,
  )
}

async function verify() {
  const blobSha = arg('blob')
  const secret = arg('secret')

  const record = (
    await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          eq(entity.canonicalName, FIXTURE.companyName),
          isNull(entity.mergedIntoId),
        ),
      )
  ).at(0)
  if (!record) throw new Error('[fixture] the company record did not come back')

  const files = await db
    .select({
      id: document.entityId,
      filename: document.filename,
      blobSha: document.blobSha,
      sizeBytes: document.sizeBytes,
    })
    .from(link)
    .innerJoin(document, eq(document.entityId, link.fromEntityId))
    .innerJoin(entity, eq(entity.id, document.entityId))
    .where(
      and(
        eq(link.toEntityId, record.id),
        eq(link.relation, 'tagged_in'),
        isNull(entity.mergedIntoId),
      ),
    )

  const filed = files.at(0)
  if (files.length !== 1 || !filed) {
    throw new Error(
      `[fixture] expected 1 filed document, listed ${files.length}`,
    )
  }
  if (filed.filename !== FIXTURE.filename || filed.blobSha !== blobSha) {
    throw new Error(
      `[fixture] the listed document is wrong: ${filed.filename} → ${filed.blobSha}`,
    )
  }
  console.log(
    `[fixture] listed: ${filed.filename} (${filed.sizeBytes} bytes) → blob ${filed.blobSha}`,
  )

  // The real vault, so the assertion is "secret.key came back", not "a row
  // came back": a wrong key throws inside AES-GCM instead of decrypting.
  const back = await resolveSecret(FIXTURE.provider)
  if (back !== secret) {
    throw new Error(
      `[fixture] the stored credential did not decrypt to what was planted (got ${back === null ? 'null' : 'a different value'})`,
    )
  }
  console.log(
    '[fixture] credential decrypts — secret.key survived the round trip',
  )
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'plant') await plant()
  else if (mode === 'verify') await verify()
  else throw new Error(`[fixture] expected "plant" or "verify", got ${mode}`)
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

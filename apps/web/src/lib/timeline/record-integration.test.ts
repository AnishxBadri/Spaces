import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * A record a plugin birthed (sdk-7a): IdentityLive writes its
 * `company.created` activity with no user — `actor_id` null, the integration
 * in `meta` (`integrationMeta`, core's one spelling of it; the port side is
 * `packages/core/src/writes/ports/identity.test.ts`) — and the timeline must
 * show that row as the plugin, not as a person and not as "System". Dynamic
 * imports, as the other timeline tests do: the harness points `DATABASE_URL`
 * at this worker's database before `@spaces/db` loads.
 */
describe('the record timeline, for a record a plugin birthed', () => {
  it('names the integration on the birth row', async () => {
    const { db } = await import('@spaces/db')
    const { integration } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { integrationMeta } =
      await import('@spaces/core/writes/ports/identity')
    const { recordTimelineProgram } = await import('./record')

    const row = (
      await db
        .insert(integration)
        .values({ capabilityId: 'apollo', version: '1.0.0', enabled: true })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Timeline Plugin Co',
      keys: { domain: 'timeline-plugin.example' },
      source: { class: 'integration', ref: row.id },
    })
    await db.insert(activity).values({
      actorId: null,
      verb: 'company.created',
      subjectEntityId: entityId,
      meta: integrationMeta(row),
    })

    const items = await Effect.runPromise(recordTimelineProgram(entityId))
    const birth = items.find(
      (i) => i.type === 'macro' && i.verb === 'company.created',
    )
    expect(birth).toMatchObject({ type: 'macro', actorName: 'apollo' })
  })
})

/**
 * A value a plugin filled (sdk-9): the burst names the integration by its
 * manifest `name` once the loader has stored one, and by its capability id
 * until then — never as "An integration".
 */
describe('the record timeline, for values a plugin filled', () => {
  it('names the burst by the manifest name, falling back to the capability id', async () => {
    const { db } = await import('@spaces/db')
    const { integration } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { setValues } = await import('@spaces/core/writes/attributes/values')
    const { integrationMeta } =
      await import('@spaces/core/writes/ports/identity')
    const { recordTimelineProgram } = await import('./record')

    const insert = async (capabilityId: string, name: string | null) => {
      const row = (
        await db
          .insert(integration)
          .values({
            capabilityId,
            version: '1.0.0',
            enabled: true,
            manifest: name === null ? null : { id: capabilityId, name },
          })
          .returning()
      ).at(0)
      if (!row) throw new Error('no row')
      return row
    }
    const named = await insert('echo', 'Echo enrichment')
    const unnamed = await insert('pdl', null)

    const born = async (name: string, domain: string) =>
      (
        await resolveEntity({
          kind: 'company',
          name,
          keys: { domain },
          source: { class: 'manual' },
        })
      ).entityId
    const echoed = await born('Named Plugin Co', 'named-plugin.example')
    const plain = await born('Unnamed Plugin Co', 'unnamed-plugin.example')
    await setValues({
      entityId: echoed,
      patch: { founded_year: 2015 },
      actor: { type: 'integration', id: named.id },
      source: 'enrichment',
    })
    await setValues({
      entityId: plain,
      patch: { founded_year: 2016 },
      actor: { type: 'integration', id: unnamed.id },
      source: 'enrichment',
    })
    await db.insert(activity).values({
      actorId: null,
      verb: 'signal.emitted',
      subjectEntityId: echoed,
      meta: integrationMeta(named),
    })

    const echoItems = await Effect.runPromise(recordTimelineProgram(echoed))
    expect(echoItems.find((i) => i.type === 'attrs')).toMatchObject({
      actorType: 'integration',
      integrationName: 'Echo enrichment',
    })
    expect(
      echoItems.find((i) => i.type === 'macro' && i.verb === 'signal.emitted'),
    ).toMatchObject({ actorName: 'Echo enrichment' })

    const plainItems = await Effect.runPromise(recordTimelineProgram(plain))
    expect(plainItems.find((i) => i.type === 'attrs')).toMatchObject({
      actorType: 'integration',
      integrationName: 'pdl',
    })
  })
})

/**
 * A document a plugin filed (sdk-8): `Content.fileDocument` runs core's
 * intake as the integration, so `uploaded_by` and the activity row's
 * `actor_id` are null — and the record page must still say who filed it.
 * The Files tab reads the ref (`documentProvenance`, "via <capability>"),
 * the timeline reads `meta.integrationId` off birth's `document.filed` row.
 */
describe('the record page, for a document a plugin filed', () => {
  it('names the integration on the Files row and the timeline line, never a user', async () => {
    const { db } = await import('@spaces/db')
    const { document, entity, integration } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { and, eq } = await import('drizzle-orm')
    const { Layer } = await import('effect')
    const { Content } = await import('@spaces/sdk')
    const { Enqueue } = await import('@spaces/core/queue/enqueue')
    const { ContentLive } = await import('@spaces/core/writes/ports/content')
    const { storage } = await import('@spaces/core/writes/storage')
    const { documentProvenance } = await import('#/lib/server/shared')
    const { recordTimelineProgram } = await import('./record')

    const row = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'importer',
          version: '0.1.0',
          enabled: true,
          manifest: { id: 'importer', name: 'Importer' },
        })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    const acme = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Filed By Plugin Co' })
        .returning({ id: entity.id })
    ).at(0)
    if (!acme) throw new Error('no company')

    const bytes = new Uint8Array(
      Buffer.from('%PDF-1.4\n% filed by a plugin\n%%EOF\n', 'utf8'),
    )
    const { documentId } = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Content).fileDocument({
          _tag: 'document',
          body: { bytes },
          filename: 'plugin-deck.pdf',
          mime: 'application/pdf',
          kind: 'deck',
          fileAgainst: [{ kind: 'record', entityId: acme.id }],
        })
      }).pipe(
        Effect.provide(
          ContentLive(row).pipe(
            Layer.provide(
              Layer.succeed(
                Enqueue,
                Enqueue.of({ enqueue: () => Effect.succeed(null) }),
              ),
            ),
          ),
        ),
      ),
    )

    const doc = (
      await db
        .select({ uploadedBy: document.uploadedBy, blobSha: document.blobSha })
        .from(document)
        .where(eq(document.entityId, documentId))
    ).at(0)
    expect(doc?.uploadedBy).toBeNull()
    const line = (
      await db
        .select({ actorId: activity.actorId })
        .from(activity)
        .where(
          and(
            eq(activity.verb, 'document.filed'),
            eq(activity.objectEntityId, documentId),
          ),
        )
    ).at(0)
    expect(line).toEqual({ actorId: null })

    // The Files tab: "via importer", never a person's name.
    expect((await documentProvenance([documentId])).get(documentId)).toEqual({
      sourceClass: 'integration',
      sourceCapability: 'importer',
    })
    // The timeline: "Importer filed a document", not "System".
    const items = await Effect.runPromise(recordTimelineProgram(acme.id))
    expect(
      items.find((i) => i.type === 'macro' && i.verb === 'document.filed'),
    ).toMatchObject({ actorName: 'Importer' })

    if (doc?.blobSha) await storage().delete(doc.blobSha)
  })
})

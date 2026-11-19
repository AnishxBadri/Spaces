import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

/**
 * Attach from a storage source (Drive): a pasted link, the provider's
 * picker, and the poll a pending row reads. Each handler is `requireUser()`
 * plus a documents program, reached by a dynamic import so Effect and
 * drizzle stay out of the client bundle.
 */

export type {
  AttachFromLinkOutcome,
  AttachFromPickerOutcome,
  LinkFetchStatus,
  PickedFile,
} from '../documents/attach-link'
export type {
  FakePickerFile,
  MintPickerOutcome,
  PickerMode,
  PickerView,
} from '../documents/picker'

const uuid = Schema.String.check(Schema.isUUID())

/** A same-origin path, never a URL: where a Connect dance lands. */
const samePath = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^\/(?!\/)/, { message: 'A path on this site' }),
)

/**
 * A link as a person pastes it: trimmed, then anything `URL` parses — the
 * scheme is not pinned, so a `mailto:` passes and the program refuses it.
 */
const pastedUrl = Schema.Trim.check(
  Schema.makeFilter((s: string) => URL.canParse(s), { expected: 'a URL' }),
  Schema.isMaxLength(2000),
)

export const attachFromLink = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        url: pastedUrl,
        attachTo: uuid,
        returnTo: samePath,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { attachFromLinkProgram, attachLinkMessage } =
      await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(attachFromLinkProgram)(u.id, data)
    } catch (failure) {
      throw new Error(attachLinkMessage(failure))
    }
  })

const pickerProvider = Schema.Literals(['google'])

export const attachFromPicker = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        provider: pickerProvider,
        attachTo: uuid,
        files: Schema.Array(
          Schema.Struct({
            id: Schema.String.check(
              Schema.isPattern(/^[\w-]+$/),
              Schema.isMaxLength(200),
            ),
            name: Schema.String.check(Schema.isMaxLength(500)),
          }),
        ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
        returnTo: samePath,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { attachFromPickerProgram, attachLinkMessage } =
      await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(attachFromPickerProgram)(u.id, data)
    } catch (failure) {
      throw new Error(attachLinkMessage(failure))
    }
  })

/**
 * Whether "Attach from Drive" can open, drawn before any click: Connect, a
 * re-consent, "Picker not set up" (an admin gets the integration's page),
 * or a refusal in words. Mints nothing.
 */
export const pickerReadiness = createServerFn()
  .validator(
    input(Schema.Struct({ provider: pickerProvider, returnTo: samePath })),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pickerReadinessProgram, pickerMessage } =
      await import('../documents/picker')
    const { effectFn } = await import('./effect')
    // SPACES_FAKE_PROVIDERS=1: the in-app pick list over the fake Drive's seed.
    const options = {
      returnTo: data.returnTo,
      fake: process.env.SPACES_FAKE_PROVIDERS === '1',
    }
    try {
      const readiness = await effectFn(pickerReadinessProgram)(
        u.id,
        data.provider,
        options,
      )
      if (readiness._tag !== 'unconfigured') return readiness
      return {
        ...readiness,
        settingsHref:
          u.role !== 'admin'
            ? null
            : readiness.integrationId === null
              ? '/settings/plugins'
              : `/settings/plugins/${readiness.integrationId}`,
      }
    } catch (failure) {
      return { _tag: 'refused' as const, reason: pickerMessage(failure) }
    }
  })

/**
 * The picker's token, minted for one opening and answered only here, over
 * POST: never in a URL, never logged. A connection holding a scope that
 * does not read a picked file is refused with the reason.
 */
export const mintPickerToken = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        provider: pickerProvider,
        returnTo: samePath,
        /** `folders` opens the picker on folders, for Link a Drive folder. */
        mode: Schema.Literals(['files', 'folders']).pipe(
          Schema.withDecodingDefault(Effect.succeed('files' as const)),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { mintPickerTokenProgram, pickerMessage } =
      await import('../documents/picker')
    const { effectFn } = await import('./effect')
    // SPACES_FAKE_PROVIDERS=1: the in-app pick list over the fake Drive's seed.
    const options = {
      returnTo: data.returnTo,
      fake: process.env.SPACES_FAKE_PROVIDERS === '1',
    }
    try {
      return await effectFn(mintPickerTokenProgram)(
        u.id,
        data.provider,
        options,
        data.mode,
      )
    } catch (failure) {
      throw new Error(pickerMessage(failure))
    }
  })

export const linkFetchStatus = createServerFn()
  .validator(
    input(
      Schema.Struct({
        fetchIds: Schema.Array(uuid).check(Schema.isMaxLength(50)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { linkFetchStatusProgram } = await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    return effectFn(linkFetchStatusProgram)(data.fetchIds)
  })

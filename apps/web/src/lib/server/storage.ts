import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Attach from a storage source (Drive): a pasted link, the provider's
 * picker, and the poll a pending row reads. Each handler is `requireUser()`
 * plus a program from `#/lib/documents`, reached by a dynamic import so
 * Effect and drizzle stay out of the client bundle (CLAUDE.md → Traps).
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

/** A same-origin path, never a URL: where a Connect dance lands. */
const samePath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/, 'A path on this site')

export const attachFromLink = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      url: z.string().url().max(2000),
      attachTo: z.string().uuid(),
      returnTo: samePath,
    }),
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

const pickerProvider = z.enum(['google'])

export const attachFromPicker = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      provider: pickerProvider,
      attachTo: z.string().uuid(),
      files: z
        .array(
          z.object({
            id: z
              .string()
              .regex(/^[\w-]+$/)
              .max(200),
            name: z.string().max(500),
          }),
        )
        .min(1)
        .max(50),
      returnTo: samePath,
    }),
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
  .validator(z.object({ provider: pickerProvider, returnTo: samePath }))
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
    z.object({
      provider: pickerProvider,
      returnTo: samePath,
      /** `folders` opens the picker on folders, for Link a Drive folder. */
      mode: z.enum(['files', 'folders']).default('files'),
    }),
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
  .validator(z.object({ fetchIds: z.array(z.string().uuid()).max(50) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { linkFetchStatusProgram } = await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    return effectFn(linkFetchStatusProgram)(data.fetchIds)
  })

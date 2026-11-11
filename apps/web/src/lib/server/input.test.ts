import { createServerFn, execValidator } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { input } from './input'

/**
 * `input()` at the server-fn boundary. The runtime half goes through
 * TanStack's own `execValidator`, which is what a server fn runs on the
 * server before its handler; a direct call to an uncompiled server fn skips
 * the validator, so the suite cannot get there any other way.
 */

const isoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected YYYY-MM-DD' }),
)

const NewTask = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  dueDate: Schema.optional(Schema.NullOr(isoDate)),
  entityIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isUUID())).check(
      Schema.isMaxLength(10),
    ),
  ),
  notify: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
})

describe('input — types', () => {
  it("gives the handler the schema's decoded type and the caller its encoded one", () => {
    const fn = createServerFn({ method: 'POST' })
      .validator(input(NewTask))
      .handler(({ data }) => {
        expectTypeOf(data).toEqualTypeOf<{
          readonly content: string
          readonly dueDate?: string | null | undefined
          readonly entityIds?: ReadonlyArray<string> | undefined
          readonly notify: boolean
        }>()
        return data.content
      })
    // `notify` is optional to the caller: the default fills it on decode.
    expectTypeOf<Parameters<typeof fn>[0]['data']>().toEqualTypeOf<{
      readonly content: string
      readonly dueDate?: string | null | undefined
      readonly entityIds?: ReadonlyArray<string> | undefined
      readonly notify?: boolean
    }>()
  })
})

describe('input — runtime', () => {
  it('passes a valid input through', async () => {
    const id = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
    await expect(
      execValidator(input(NewTask), {
        content: 'Call the founder',
        dueDate: '2026-11-20',
        entityIds: [id],
        notify: true,
      }),
    ).resolves.toEqual({
      content: 'Call the founder',
      dueDate: '2026-11-20',
      entityIds: [id],
      notify: true,
    })
  })

  it('hands the handler the transformed value: trimmed, defaulted', async () => {
    await expect(
      execValidator(input(NewTask), { content: '  Call the founder \n' }),
    ).resolves.toEqual({ content: 'Call the founder', notify: false })
  })

  it('drops a key the schema does not name, as zod did', async () => {
    await expect(
      execValidator(input(NewTask), { content: 'x', role: 'admin' }),
    ).resolves.toEqual({ content: 'x', notify: false })
  })

  it('refuses an invalid input naming every field and what it expected', async () => {
    const refused = execValidator(input(NewTask), {
      content: '   ',
      dueDate: '20/11/2026',
      entityIds: ['not-an-id'],
    })
    await expect(refused).rejects.toMatchObject({
      _tag: 'InputRefused',
      message:
        'content: Expected a value with a length of at least 1; ' +
        'dueDate: Expected YYYY-MM-DD; ' +
        'entityIds[0]: Expected a UUID',
    })
  })

  it('refuses a missing input whole, with no field to name', async () => {
    await expect(execValidator(input(NewTask), undefined)).rejects.toThrowError(
      /^Expected object/,
    )
  })

  it('refuses a wrong type and an over-long array', async () => {
    await expect(
      execValidator(input(NewTask), {
        content: 7,
        entityIds: Array.from(
          { length: 11 },
          () => '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11',
        ),
      }),
    ).rejects.toThrowError(
      'content: Expected string; ' +
        'entityIds: Expected a value with a length of at most 10',
    )
  })
})

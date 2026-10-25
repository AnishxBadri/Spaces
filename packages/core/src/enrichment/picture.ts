import type { VocabularyKey } from '@spaces/sdk/vocabulary'

/**
 * A record's picture, pure half: which key answers it, what a fetched
 * response must be to become one, and the words a refusal puts on the run's
 * timeline line.
 * - The picture is fetched once and stored as a blob, never hotlinked, so
 *   no view loads a third party's image.
 * - Raster images only, judged by their bytes: SVG is a script vector.
 */

/** The vocabulary key that answers each kind's picture. */
export const PICTURE_KEYS = {
  company: 'company.logo',
  person: 'person.photo',
} as const satisfies { readonly [kind: string]: VocabularyKey }

/** What the run's timeline line calls each kind's picture. */
export const PICTURE_NAMES = { company: 'Logo', person: 'Photo' } as const

export const isPictureKey = (key: string): boolean =>
  key === PICTURE_KEYS.company || key === PICTURE_KEYS.person

/** The cap on one picture's bytes; a larger response sets nothing. */
export const PICTURE_MAX_BYTES = 2 * 1024 * 1024

export type PictureType =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon'

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>) =>
  prefix.every((b, i) => bytes[i] === b)

/** The raster type the bytes are, or null: the magic numbers, never a header. */
export const sniffPicture = (bytes: Uint8Array): PictureType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  )
    return 'image/webp'
  if (bytes.length > 6 && startsWith(bytes, [0x00, 0x00, 0x01, 0x00]))
    return 'image/x-icon'
  return null
}

/** Why a picture was not set, as the run line says it. */
export type PictureRefusal = 'not an image' | 'too large' | 'unreachable'

/**
 * Why a response cannot be a picture, or its type when it can:
 * - a declared type other than a raster image is refused before the bytes;
 * - the bytes must sniff as a raster image whatever was declared;
 * - more than `PICTURE_MAX_BYTES` is too large.
 */
export const judgePicture = (
  contentType: string | null,
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly type: PictureType }
  | { readonly ok: false; readonly why: PictureRefusal } => {
  if (bytes.length > PICTURE_MAX_BYTES) return { ok: false, why: 'too large' }
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (
    declared !== '' &&
    declared !== 'application/octet-stream' &&
    (!declared.startsWith('image/') || declared.startsWith('image/svg'))
  )
    return { ok: false, why: 'not an image' }
  const type = sniffPicture(bytes)
  return type === null ? { ok: false, why: 'not an image' } : { ok: true, type }
}

/**
 * The keys a source is asked for, with the picture's when the record still
 * wants one and no earlier source in the run answered it.
 */
export const withPictureKey = (
  keys: ReadonlyArray<string>,
  picture: VocabularyKey | null,
  answered: ReadonlySet<string>,
): Array<string> =>
  picture === null || answered.has(picture) || keys.includes(picture)
    ? [...keys]
    : [...keys, picture]

/** The run's first answer for the picture key, in source order. */
export type PictureAnswer = {
  readonly key: VocabularyKey
  readonly url: string
  readonly integrationId: string
  readonly receiptId: string
}

export const pictureAnswerOf = (
  key: VocabularyKey,
  answers: ReadonlyArray<{
    readonly integrationId: string
    readonly receiptId: string
    readonly answers: { readonly [key: string]: unknown }
  }>,
): PictureAnswer | null => {
  for (const answer of answers) {
    const url = answer.answers[key]
    if (typeof url === 'string')
      return {
        key,
        url,
        integrationId: answer.integrationId,
        receiptId: answer.receiptId,
      }
  }
  return null
}

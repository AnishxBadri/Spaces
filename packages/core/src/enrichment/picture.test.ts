import { describe, expect, it } from 'vitest'
import {
  PICTURE_KEYS,
  PICTURE_MAX_BYTES,
  judgePicture,
  pictureAnswerOf,
  sniffPicture,
  withPictureKey,
} from './picture'

const bytes = (...b: Array<number>) => new Uint8Array(b)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBPVP8 '),
])
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
)

describe('sniffPicture', () => {
  it('reads the raster types by their magic numbers, and nothing else', () => {
    expect(sniffPicture(PNG)).toBe('image/png')
    expect(sniffPicture(JPEG)).toBe('image/jpeg')
    expect(sniffPicture(WEBP)).toBe('image/webp')
    expect(sniffPicture(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffPicture(SVG)).toBeNull()
    expect(sniffPicture(new Uint8Array())).toBeNull()
  })
})

describe('judgePicture', () => {
  it('takes a raster image, whatever generic type it was served as', () => {
    expect(judgePicture('image/png', PNG)).toEqual({
      ok: true,
      type: 'image/png',
    })
    expect(judgePicture(null, JPEG)).toEqual({ ok: true, type: 'image/jpeg' })
    expect(judgePicture('application/octet-stream', PNG)).toMatchObject({
      ok: true,
    })
  })

  it('refuses an SVG, a page, bytes that are not an image, and too many bytes', () => {
    expect(judgePicture('image/svg+xml', SVG)).toEqual({
      ok: false,
      why: 'not an image',
    })
    expect(judgePicture('text/html; charset=utf-8', PNG)).toEqual({
      ok: false,
      why: 'not an image',
    })
    expect(judgePicture('image/png', SVG)).toEqual({
      ok: false,
      why: 'not an image',
    })
    const big = new Uint8Array(PICTURE_MAX_BYTES + 1)
    big.set(PNG)
    expect(judgePicture('image/png', big)).toEqual({
      ok: false,
      why: 'too large',
    })
  })
})

describe('withPictureKey', () => {
  it('asks for the picture while it is wanted and no earlier source answered it', () => {
    const logo = PICTURE_KEYS.company
    expect(withPictureKey(['company.description'], logo, new Set())).toEqual([
      'company.description',
      logo,
    ])
    expect(withPictureKey(['company.description'], null, new Set())).toEqual([
      'company.description',
    ])
    expect(withPictureKey([], logo, new Set([logo]))).toEqual([])
  })
})

describe('pictureAnswerOf', () => {
  it('takes the first source’s answer for the key', () => {
    const answers = [
      {
        integrationId: 'a',
        receiptId: 'r1',
        answers: { 'company.ticker': 'X' },
      },
      {
        integrationId: 'b',
        receiptId: 'r2',
        answers: { 'person.photo': 'https://b.example/p.jpg' },
      },
      {
        integrationId: 'c',
        receiptId: 'r3',
        answers: { 'person.photo': 'https://c.example/p.jpg' },
      },
    ]
    expect(pictureAnswerOf(PICTURE_KEYS.person, answers)).toEqual({
      key: 'person.photo',
      url: 'https://b.example/p.jpg',
      integrationId: 'b',
      receiptId: 'r2',
    })
    expect(pictureAnswerOf(PICTURE_KEYS.company, answers)).toBeNull()
  })
})

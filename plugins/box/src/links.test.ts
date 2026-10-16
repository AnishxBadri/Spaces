import { describe, expect, it } from 'vitest'
import { parseBoxLink } from './links.ts'

describe('parseBoxLink', () => {
  it.each([
    ['https://app.box.com/folder/1001', { kind: 'folder', id: '1001' }],
    ['https://app.box.com/folder/0', { kind: 'folder', id: '0' }],
    ['https://app.box.com/file/2002?s=abc', { kind: 'file', id: '2002' }],
    ['https://app.box.com/notes/2001', { kind: 'file', id: '2001' }],
    ['https://acme.app.box.com/folder/1001/', { kind: 'folder', id: '1001' }],
    [
      'https://app.box.com/s/acmedataroom',
      { kind: 'shared', url: 'https://app.box.com/s/acmedataroom' },
    ],
    [
      'https://acme.box.com/s/acmedeck?page=2#x',
      { kind: 'shared', url: 'https://acme.box.com/s/acmedeck' },
    ],
    [
      'https://acme.app.box.com/v/board-pack',
      { kind: 'shared', url: 'https://acme.app.box.com/v/board-pack' },
    ],
    [
      'https://app.box.com/s/acmedataroom/file/2002',
      { kind: 'file', id: '2002' },
    ],
  ])('reads %s', (url, expected) => {
    expect(parseBoxLink(url)).toEqual(expected)
  })

  it.each([
    'https://drive.google.com/drive/folders/dataroom',
    'https://app.box.com/folder/abc',
    'https://app.box.com/',
    'https://app.box.com/search?q=acme',
    'https://account.box.com/api/oauth2/authorize',
    'https://api.box.com/2.0/folders/1001',
    'https://acme.box.com/folder/1001',
    'https://box.com.example.net/folder/1001',
    'ftp://app.box.com/folder/1001',
    'not a url',
  ])('is null for %s', (url) => {
    expect(parseBoxLink(url)).toBeNull()
  })
})

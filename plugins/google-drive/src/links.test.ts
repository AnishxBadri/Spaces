import { describe, expect, it } from 'vitest'
import { parseDriveLink } from './links.ts'

/** The six forms people paste, and what is not one of them. */
describe('parseDriveLink', () => {
  it.each([
    [
      'a file',
      'https://drive.google.com/file/d/1AbC-d_9/view?usp=sharing',
      { id: '1AbC-d_9', form: 'file' },
    ],
    [
      'a folder',
      'https://drive.google.com/drive/folders/0B-folder_1',
      { id: '0B-folder_1', form: 'folder' },
    ],
    [
      'a folder, signed in as a second account',
      'https://drive.google.com/drive/u/1/folders/0B-folder_1?resourcekey=x',
      { id: '0B-folder_1', form: 'folder' },
    ],
    [
      'a shared drive',
      'https://drive.google.com/drive/folders/0AShared-Drive',
      { id: '0AShared-Drive', form: 'folder' },
    ],
    [
      '/open?id=',
      'https://drive.google.com/open?id=1Open-Id',
      { id: '1Open-Id', form: 'either' },
    ],
    [
      'a Doc in the editor',
      'https://docs.google.com/document/d/1Doc_Id/edit#heading=h.1',
      { id: '1Doc_Id', form: 'file' },
    ],
    [
      'a Sheet in the editor',
      'https://docs.google.com/spreadsheets/d/1Sheet-Id/edit?gid=0',
      { id: '1Sheet-Id', form: 'file' },
    ],
    [
      'Slides in the editor',
      'https://docs.google.com/presentation/d/1Slides-Id/edit',
      { id: '1Slides-Id', form: 'file' },
    ],
    [
      'a Doc, signed in as a second account',
      'https://docs.google.com/document/u/2/d/1Doc_Id/edit',
      { id: '1Doc_Id', form: 'file' },
    ],
  ])('reads %s', (_, url, expected) => {
    expect(parseDriveLink(url)).toEqual(expected)
  })

  it.each([
    ['a Dropbox link', 'https://www.dropbox.com/sh/abc/AAA?dl=0'],
    ['a Box link', 'https://app.box.com/s/abc123'],
    ['an arbitrary page', 'https://example.com/file/d/1AbC/view'],
    [
      'Drive on a look-alike host',
      'https://drive.google.com.evil.example/file/d/1AbC',
    ],
    ['the Drive home page', 'https://drive.google.com/drive/my-drive'],
    ['a Drive search', 'https://drive.google.com/drive/search?q=memo'],
    ['/open with no id', 'https://drive.google.com/open'],
    ['/open with a junk id', "https://drive.google.com/open?id=a'b"],
    ['a Doc with no id', 'https://docs.google.com/document/d/'],
    ['not a URL', 'memo.docx'],
    ['another scheme', 'ftp://drive.google.com/file/d/1AbC'],
  ])('is null for %s', (_, url) => {
    expect(parseDriveLink(url)).toBeNull()
  })
})

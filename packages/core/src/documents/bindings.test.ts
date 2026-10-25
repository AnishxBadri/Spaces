import { describe, expect, it } from 'vitest'
import {
  bindingConflict,
  bindingConflictMessage,
  folderNameOf,
  isBindableKind,
} from './bindings'
import type { ExistingBinding } from './bindings'

/** The nesting guard as an id-prefix test, both ways. */

const OHMIUM: ExistingBinding = {
  folderId: 'ohmium',
  ancestorIds: ['root'],
  path: 'My Drive / Ohmium',
  targetName: 'Ohmium',
  binderName: 'Priya',
}

const DATA_ROOM = {
  folderId: 'dataroom',
  ancestorIds: ['root', 'ohmium'],
  path: 'My Drive / Ohmium / Data room',
}

describe('bindingConflict', () => {
  it('refuses a folder inside a bound one', () => {
    const conflict = bindingConflict(DATA_ROOM, [OHMIUM])
    expect(conflict?._tag).toBe('inside')
    expect(
      conflict === null ? '' : bindingConflictMessage(DATA_ROOM, conflict),
    ).toBe(
      'My Drive / Ohmium / Data room is inside My Drive / Ohmium, which is linked to Ohmium. A folder has one owner.',
    )
  })

  it('refuses a parent of a bound folder', () => {
    const bound: ExistingBinding = {
      ...DATA_ROOM,
      targetName: 'Ohmium Series B',
      binderName: null,
    }
    const parent = {
      folderId: 'ohmium',
      ancestorIds: ['root'],
      path: 'My Drive / Ohmium',
    }
    const conflict = bindingConflict(parent, [bound])
    expect(conflict?._tag).toBe('contains')
    expect(
      conflict === null ? '' : bindingConflictMessage(parent, conflict),
    ).toBe(
      'My Drive / Ohmium holds My Drive / Ohmium / Data room, which is linked to Ohmium Series B. A folder has one owner.',
    )
  })

  it('refuses the same folder, naming who bound it', () => {
    const same = {
      folderId: 'ohmium',
      ancestorIds: ['root'],
      path: 'My Drive / Ohmium',
    }
    const conflict = bindingConflict(same, [OHMIUM])
    expect(conflict?._tag).toBe('same')
    expect(
      conflict === null ? '' : bindingConflictMessage(same, conflict),
    ).toBe('My Drive / Ohmium is already linked to Ohmium by Priya.')
  })

  it('refuses a folder under a bound one whose ancestry each binder saw only in part', () => {
    // A sees R / X / Y and binds Y; B has only Y shared and binds Y / Z.
    const y: ExistingBinding = {
      folderId: 'y',
      ancestorIds: ['r', 'x'],
      path: 'R / X / Y',
      targetName: 'Ohmium',
      binderName: 'Priya',
    }
    const z = { folderId: 'z', ancestorIds: ['y'], path: 'Y / Z' }
    expect(bindingConflict(z, [y])?._tag).toBe('inside')
    // And the other way round: B bound Y / Z first, A now binds Y.
    const zBound: ExistingBinding = {
      ...z,
      targetName: 'Ohmium',
      binderName: null,
    }
    const yAgain = { folderId: 'y', ancestorIds: ['r', 'x'], path: 'R / X / Y' }
    expect(bindingConflict(yAgain, [zBound])?._tag).toBe('contains')
  })

  it('lets siblings and strangers through', () => {
    const sibling = {
      folderId: 'acme',
      ancestorIds: ['root'],
      path: 'My Drive / Acme',
    }
    const shared = {
      folderId: 'sd-acme',
      ancestorIds: ['sd-portfolio'],
      path: 'Portfolio / Acme',
    }
    expect(bindingConflict(sibling, [OHMIUM])).toBeNull()
    expect(bindingConflict(shared, [OHMIUM])).toBeNull()
    // Sharing the drive root is not nesting: the root itself is not bound.
    expect(
      bindingConflict(DATA_ROOM, [{ ...OHMIUM, folderId: 'other' }]),
    ).toBeNull()
  })
})

describe('isBindableKind', () => {
  it('takes a space, company, deal or custom record and nothing else', () => {
    expect(['company', 'deal', 'space', 'custom'].map(isBindableKind)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(['person', 'note', 'document'].map(isBindableKind)).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe('folderNameOf', () => {
  it('is the last segment of a provider path, the path itself when it has none', () => {
    expect(folderNameOf('My Drive / Vayu / Legal')).toBe('Legal')
    expect(folderNameOf('Legal')).toBe('Legal')
    expect(folderNameOf(' / ')).toBe(' / ')
  })
})

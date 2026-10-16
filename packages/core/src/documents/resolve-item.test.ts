import { describe, expect, it } from 'vitest'
import { FAKE_DRIVE_RESEARCH_SEED } from '@spaces/sdk/testing'
import { DOCUMENT_KINDS, KIND_FOLDER_NAMES, guessKindFromFolder } from './index'
import { lookupFor, resolveItem } from './resolve-item'
import type { CompanyMatch, FolderLookups, ItemTarget } from './resolve-item'

/**
 * `resolveItem` against §5.3's rows and the seeded research tree. Pure: no
 * database, no provider, no model — the lookups the walk would make are
 * handed in, so every decision below is made with no AI configured at all.
 */

const SPACE: ItemTarget = {
  entityKind: 'space',
  entityId: 'space:hydrogen',
  documentKind: null,
}
const COMPANY: ItemTarget = {
  entityKind: 'company',
  entityId: 'company:ohmium',
  documentKind: null,
}
const DEAL: ItemTarget = {
  entityKind: 'deal',
  entityId: 'deal:ohmium-b',
  documentKind: null,
}

const OHMIUM_FUZZY: CompanyMatch = {
  verdict: 'fuzzy',
  candidates: [{ entityId: 'company:ohmium', name: 'Ohmium', score: 0.44 }],
}

const DEALS: FolderLookups = {
  lookup: 'deals',
  deals: [
    { entityId: 'deal:ohmium-b', name: 'Ohmium Series B' },
    { entityId: 'deal:ohmium-a', name: 'Ohmium Series A' },
  ],
}

const company = (match: CompanyMatch): FolderLookups => ({
  lookup: 'company',
  company: match,
})
const NONE: FolderLookups = { lookup: 'none' }

describe('guessKindFromFolder', () => {
  it('matches whole names in any case', () => {
    for (const name of ['Data Room', 'data room', 'DATA ROOM', 'data_room'])
      expect(guessKindFromFolder(name)).toBe('dd')
    expect(guessKindFromFolder('Ohmium Data Room')).toBeNull()
    expect(guessKindFromFolder('Documents')).toBeNull()
    expect(guessKindFromFolder('Pitch')).toBe('deck')
    expect(guessKindFromFolder('Cap table')).toBe('cap_table')
    expect(guessKindFromFolder('Contracts')).toBe('legal')
    expect(guessKindFromFolder('Press')).toBe('article')
  })

  it('maps into DOCUMENT_KINDS and nothing else', () => {
    const kinds = Object.keys(KIND_FOLDER_NAMES)
    expect([...kinds, 'other'].sort()).toEqual([...DOCUMENT_KINDS].sort())
    for (const names of Object.values(KIND_FOLDER_NAMES))
      for (const name of names)
        expect(DOCUMENT_KINDS).toContain(guessKindFromFolder(name))
  })
})

describe('resolveItem, §5.3 row by row', () => {
  const rows: ReadonlyArray<{
    readonly row: string
    readonly name: string
    readonly parent: ItemTarget
    readonly mapSubfolders: boolean
    readonly lookups: FolderLookups
    readonly target: string
    readonly documentKind: string | null
    readonly candidates: number
  }> = [
    {
      row: 'map_subfolders off → same target as parent',
      name: 'Ohmium',
      parent: SPACE,
      mapSubfolders: false,
      lookups: NONE,
      target: 'space:hydrogen',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'space, identity/exact match → that company',
      name: 'Ohmium',
      parent: SPACE,
      mapSubfolders: true,
      lookups: company({ verdict: 'attach', entityId: 'company:ohmium' }),
      target: 'company:ohmium',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'space, fuzzy only → suggestion; files stay on the space',
      name: 'Ohium',
      parent: SPACE,
      mapSubfolders: true,
      lookups: company(OHMIUM_FUZZY),
      target: 'space:hydrogen',
      documentKind: null,
      candidates: 1,
    },
    {
      row: 'space, no match → stays on the space',
      name: 'Electrolysers',
      parent: SPACE,
      mapSubfolders: true,
      lookups: company({ verdict: 'no_match' }),
      target: 'space:hydrogen',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'company, name matches one of its deals → that deal',
      name: 'ohmium series-b',
      parent: COMPANY,
      mapSubfolders: true,
      lookups: DEALS,
      target: 'deal:ohmium-b',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'company, a near-miss deal name → the kind rules, here none',
      name: 'Ohmium Series B2',
      parent: COMPANY,
      mapSubfolders: true,
      lookups: DEALS,
      target: 'company:ohmium',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'company, kind folder → parent, kind preset',
      name: 'Data room',
      parent: COMPANY,
      mapSubfolders: true,
      lookups: DEALS,
      target: 'company:ohmium',
      documentKind: 'dd',
      candidates: 0,
    },
    {
      row: 'company, else → parent',
      name: 'Documents',
      parent: COMPANY,
      mapSubfolders: true,
      lookups: DEALS,
      target: 'company:ohmium',
      documentKind: null,
      candidates: 0,
    },
    {
      row: 'deal, kind folder → deal + kind',
      name: 'Legal',
      parent: DEAL,
      mapSubfolders: true,
      lookups: NONE,
      target: 'deal:ohmium-b',
      documentKind: 'legal',
      candidates: 0,
    },
    {
      row: 'deal, else → deal',
      name: 'Documents',
      parent: DEAL,
      mapSubfolders: true,
      lookups: NONE,
      target: 'deal:ohmium-b',
      documentKind: null,
      candidates: 0,
    },
  ]

  it.each(rows)('$row', (r) => {
    const decided = resolveItem({ kind: 'folder', name: r.name }, r.parent, {
      mapSubfolders: r.mapSubfolders,
      lookups: r.lookups,
    })
    expect(decided.target.entityId).toBe(r.target)
    expect(decided.target.documentKind).toBe(r.documentKind)
    expect(decided.candidates).toHaveLength(r.candidates)
  })

  it('asks for the company under a space, the deals under a company, nothing else', () => {
    expect(lookupFor(SPACE, true)).toBe('company')
    expect(lookupFor(COMPANY, true)).toBe('deals')
    expect(lookupFor(DEAL, true)).toBe('none')
    expect(lookupFor(SPACE, false)).toBe('none')
  })

  it('files a file by the ladder: folder, then filename, then other', () => {
    const file = (name: string, parent: ItemTarget) =>
      resolveItem({ kind: 'file', name }, parent).documentKind
    const documents = resolveItem({ kind: 'folder', name: 'Documents' }, DEAL, {
      mapSubfolders: true,
      lookups: NONE,
    }).target
    const dataRoom = resolveItem({ kind: 'folder', name: 'Data room' }, DEAL, {
      mapSubfolders: true,
      lookups: NONE,
    }).target
    expect(file('Ohmium Pitch Deck.pdf', documents)).toBe('deck')
    expect(file('notes.txt', dataRoom)).toBe('dd')
    expect(file('Ohmium Pitch Deck.pdf', dataRoom)).toBe('dd')
    expect(file('notes.txt', documents)).toBe('other')
  })
})

/** The seeded tree walked breadth first, as the sync walks it. */
const walkSeed = (
  rootId: string,
  root: ItemTarget,
  mapSubfolders: boolean,
  lookupsOf: (parent: ItemTarget, name: string) => FolderLookups,
) => {
  const decisions: Array<string> = []
  const queue = [{ id: rootId, path: '', target: root }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const folder = next
    for (const item of FAKE_DRIVE_RESEARCH_SEED.filter(
      (i) => i.parentId === folder.id,
    )) {
      const path = `${folder.path}${item.name}`
      if (item.kind === 'folder') {
        const decided = resolveItem(
          { kind: 'folder', name: item.name },
          folder.target,
          {
            mapSubfolders,
            lookups: lookupsOf(folder.target, item.name),
          },
        )
        for (const c of decided.candidates)
          decisions.push(`${path}/ → suggest ${c.name}`)
        queue.push({ id: item.id, path: `${path} / `, target: decided.target })
        continue
      }
      const decided = resolveItem(
        { kind: 'file', name: item.name },
        folder.target,
      )
      decisions.push(
        `${path} → ${decided.target.entityId} as ${decided.documentKind}`,
      )
    }
  }
  return decisions
}

/** What the walk's lookups would read with Ohmium and its Series B held. */
const heldOhmium = (parent: ItemTarget, name: string): FolderLookups => {
  const needed = lookupFor(parent, true)
  if (needed === 'company')
    return company(
      name === 'Ohmium'
        ? { verdict: 'attach', entityId: 'company:ohmium' }
        : name === 'Ohium'
          ? OHMIUM_FUZZY
          : { verdict: 'no_match' },
    )
  if (needed === 'deals') return DEALS
  return NONE
}

describe('the seeded Research / Hydrogen tree', () => {
  it('bound to a space with map_subfolders on', () => {
    expect(walkSeed('hydrogen', SPACE, true, heldOhmium))
      .toMatchInlineSnapshot(`
      [
        "Hydrogen market map.pdf → space:hydrogen as other",
        "Ohium/ → suggest Ohmium",
        "Ohmium / Ohmium overview.pdf → company:ohmium as other",
        "Ohium / Ohium intro.pdf → space:hydrogen as other",
        "Ohmium / Data room / notes.txt → company:ohmium as dd",
        "Ohmium / Data room / Ohmium model.xlsx → company:ohmium as dd",
        "Ohmium / Documents / Ohmium Deck.pdf → company:ohmium as deck",
        "Ohmium / Ohmium Series B / Series B term sheet.pdf → deal:ohmium-b as legal",
      ]
    `)
  })

  it('bound to a space with map_subfolders off', () => {
    expect(walkSeed('hydrogen', SPACE, false, heldOhmium))
      .toMatchInlineSnapshot(`
      [
        "Hydrogen market map.pdf → space:hydrogen as other",
        "Ohmium / Ohmium overview.pdf → space:hydrogen as other",
        "Ohium / Ohium intro.pdf → space:hydrogen as other",
        "Ohmium / Data room / notes.txt → space:hydrogen as other",
        "Ohmium / Data room / Ohmium model.xlsx → space:hydrogen as other",
        "Ohmium / Documents / Ohmium Deck.pdf → space:hydrogen as deck",
        "Ohmium / Ohmium Series B / Series B term sheet.pdf → space:hydrogen as legal",
      ]
    `)
  })

  it('an empty folder decides a target and files nothing', () => {
    const decisions = walkSeed('electrolysers', SPACE, true, heldOhmium)
    expect(decisions).toEqual([])
  })
})

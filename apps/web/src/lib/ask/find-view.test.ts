import { describe, expect, it } from 'vitest'
import {
  FIND_FOLD,
  engineFor,
  findQuestion,
  foldLine,
  foundOnLabel,
  lookForFrom,
  restWord,
  rowAction,
  rowMenu,
  savedWatchLine,
  shownRows,
  spaceNameFrom,
} from './find-view'
import { WEB_CHIP, withMention, withWeb } from './page-scope'
import { rpcMessages, toolKey, urlsIn } from './mount'
import type { AskFindRow, AskFindTable } from './types'

/** The Find table's rules and the web chip, pure. */

const via = { integrationId: 'i', name: 'Exa' }
const row = (domain: string, standing: AskFindRow['standing']): AskFindRow => ({
  name: domain,
  domain,
  line: '',
  place: null,
  sources: [{ url: `https://${domain}/` }],
  via,
  standing,
  entityId: standing === 'unknown' ? null : `e-${domain}`,
})
const table = (
  rows: Array<AskFindRow>,
  hidden = 0,
  space: AskFindTable['space'] = { id: 's', name: 'Property ops' },
): AskFindTable => ({ space, rows, hidden })

describe('the find table', () => {
  it('folds past twelve rows and prints what is folded and hidden once', () => {
    const t = table(
      Array.from({ length: 25 }, (_, i) =>
        row(`c${String(i)}.example`, 'unknown'),
      ),
      2,
    )
    expect(shownRows(t, false)).toHaveLength(FIND_FOLD)
    expect(foldLine(t, false)).toBe('+13 more · 2 hidden')
    expect(shownRows(t, true)).toHaveLength(25)
    expect(foldLine(t, true)).toBe('2 hidden')
    expect(foldLine(table([row('a.example', 'unknown')]), false)).toBeNull()
  })

  it('ends a row on one action: Add for a web result, File here for a held one with a space', () => {
    const t = table([])
    expect(rowAction(row('a.example', 'unknown'), t)).toBe('add')
    expect(rowAction(row('b.example', 'held'), t)).toBe('file')
    expect(rowAction(row('c.example', 'filed'), t)).toBeNull()
    expect(rowAction(row('b.example', 'held'), table([], 0, null))).toBeNull()
  })

  it('puts Add and file here and Dismiss in the ···, only with a space; a filed row has none', () => {
    const t = table([])
    expect(rowMenu(row('a.example', 'unknown'), t)).toEqual([
      'add-and-file',
      'dismiss',
    ])
    expect(rowMenu(row('b.example', 'held'), t)).toEqual(['dismiss'])
    expect(rowMenu(row('c.example', 'filed'), t)).toEqual([])
    expect(rowMenu(row('a.example', 'unknown'), table([], 0, null))).toEqual([])
  })

  it('reads filed and held as sentence-case state words; a web result says nothing', () => {
    expect(restWord(row('a.example', 'filed'))).toBe('Filed')
    expect(restWord(row('a.example', 'held'))).toBe('Held')
    expect(restWord(row('a.example', 'unknown'))).toBeNull()
  })

  it('prints Found on as the first page’s host and how many more', () => {
    const r = row('a.example', 'unknown')
    expect(
      foundOnLabel({
        ...r,
        sources: [
          { url: 'https://www.yourstory.com/a' },
          { url: 'https://inc42.com/b' },
        ],
      }),
    ).toBe('yourstory.com +1')
    expect(
      foundOnLabel({ ...r, sources: [{ url: 'https://inc42.com/b' }] }),
    ).toBe('inc42.com')
    expect(foundOnLabel({ ...r, sources: [] })).toBe('')
  })

  it('prefills the question from the space’s criteria', () => {
    expect(
      findQuestion('Property ops', 'Software for landlords in India.'),
    ).toBe('Find companies that match: Software for landlords in India.')
    expect(findQuestion('Property ops', null)).toBe(
      'Find companies that belong in Property ops.',
    )
  })
})

describe('the web chip', () => {
  it('follows the chips while a plugin can mount and the reader keeps it', () => {
    const space = { kind: 'space' as const, id: 's', name: 'Ops', href: null }
    expect(withWeb([space], true, true)).toEqual([space, WEB_CHIP])
    expect(withWeb([space], false, true)).toEqual([space])
    expect(withWeb([space], true, false)).toEqual([space])
  })

  it('is never counted by an @ pick, so it evicts no chip', () => {
    const chip = (id: string) => ({
      kind: 'record' as const,
      id,
      name: id,
      href: null,
    })
    const space = { kind: 'space' as const, id: 's', name: 'Ops', href: null }
    let scope: ReturnType<typeof withMention> = [space, WEB_CHIP]
    for (const id of ['a', 'b', 'c']) scope = withMention(scope, chip(id))
    expect(scope).toEqual([space, chip('a'), chip('b'), chip('c'), WEB_CHIP])
    expect(withMention(scope, chip('d'))).toEqual([
      chip('a'),
      chip('b'),
      chip('c'),
      chip('d'),
      WEB_CHIP,
    ])
  })
})

describe('the MCP wire', () => {
  it('reads a JSON body and an event stream alike', () => {
    expect(
      rpcMessages('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}'),
    ).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
    expect(
      rpcMessages(
        'text/event-stream',
        'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"a":1}}\n\n: ping\n\n',
      ),
    ).toEqual([{ jsonrpc: '2.0', id: 2, result: { a: 1 } }])
    expect(rpcMessages('application/json', 'not json')).toEqual([])
  })

  it('finds each page an answer names once, without trailing punctuation', () => {
    expect(
      urlsIn(
        'See https://a.example/x. Also (https://b.example/y) and https://a.example/x',
      ),
    ).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  it('keys a tool by its plugin within the model’s name rules', () => {
    expect(toolKey('exa', 'web_search_exa')).toBe('exa__web_search_exa')
    expect(toolKey('exa', 'search.v2')).toBe('exa__search_v2')
  })
})

describe('Save as watch', () => {
  it('names a space from the question: one line, no closing stop, cut at a word', () => {
    expect(spaceNameFrom('  Property ops\nin Pune? ')).toBe(
      'Property ops in Pune',
    )
    const long =
      'Find property management operators and rental platforms across Pune and Mumbai'
    const name = spaceNameFrom(long)
    expect(name.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(name)).toBe(true)
    expect(long.charAt(name.length)).toBe(' ')
  })

  it('prefills Look for with the question, blank when it is the criteria', () => {
    expect(lookForFrom('Rental software', null)).toBe('Rental software')
    expect(lookForFrom('Rental software', ' Rental software ')).toBe('')
    expect(lookForFrom('Rental software', 'Something else')).toBe(
      'Rental software',
    )
  })

  it('opens on the engine the rows came through when it can watch, else the first', () => {
    const t = table([row('a.in', 'unknown')])
    expect(engineFor(t, [{ integrationId: 'x' }, { integrationId: 'i' }])).toBe(
      'i',
    )
    expect(engineFor(t, [{ integrationId: 'x' }])).toBe('x')
    expect(engineFor(t, [])).toBeNull()
  })

  it('says the saved watch is gone once it is', () => {
    const saved = { id: 'w', spaceId: 's', spaceName: 'Property ops' }
    expect(savedWatchLine(saved)).toBe('Saved as a watch on Property ops')
    expect(savedWatchLine({ ...saved, deleted: true })).toBe(
      'Saved as a watch on Property ops · watch deleted',
    )
  })
})

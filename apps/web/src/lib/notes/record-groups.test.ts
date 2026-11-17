import { describe, expect, it } from 'vitest'
import { noteExcerpt } from './excerpt'
import {
  filterNoteGroups,
  noteFilterCounts,
  recordNoteGroups,
  recordNotesCount,
} from './record-groups'
import type { NoteFilter } from './record-groups'

/**
 * A record's Notes tab order: filed and mentioning notes first with memos
 * pinned, the meetings' notes after, every superseded note last; and the
 * excerpt each row prints under its title.
 */

const note = (
  id: string,
  over: Partial<{
    kind: 'note' | 'memo'
    updatedAt: string
    supersededBy: string | null
  }> = {},
) => ({
  id,
  kind: over.kind ?? ('note' as const),
  updatedAt: over.updatedAt ?? '2026-10-01T10:00:00.000Z',
  supersededBy: over.supersededBy ?? null,
})

describe('recordNoteGroups', () => {
  it('lists filed notes memos first, then the meetings’ notes, a note in two lanes once', () => {
    const groups = recordNoteGroups({
      filed: [
        note('loose', { updatedAt: '2026-10-09' }),
        note('memo', { kind: 'memo', updatedAt: '2026-10-01' }),
        note('granola', { updatedAt: '2026-10-05' }),
      ],
      fromMeetings: [note('granola'), note('write-up')],
      mentions: [note('aside', { updatedAt: '2026-10-07' })],
    })
    expect(groups.notes.map((n) => n.id)).toEqual([
      'memo',
      'loose',
      'aside',
      'granola',
    ])
    expect(groups.meetings.map((n) => n.id)).toEqual(['write-up'])
    expect(groups.superseded).toEqual([])
  })

  it('moves a superseded note to the foot, whichever lane it was in, newest first', () => {
    const groups = recordNoteGroups({
      filed: [
        note('v1', {
          kind: 'memo',
          supersededBy: 'v2',
          updatedAt: '2026-09-01',
        }),
        note('v2', { kind: 'memo', updatedAt: '2026-10-01' }),
      ],
      fromMeetings: [
        note('old call', { supersededBy: 'v2', updatedAt: '2026-09-20' }),
        note('call'),
      ],
      mentions: [],
    })
    expect(groups.notes.map((n) => n.id)).toEqual(['v2'])
    expect(groups.meetings.map((n) => n.id)).toEqual(['call'])
    expect(groups.superseded.map((n) => n.id)).toEqual(['old call', 'v1'])
  })

  it('splits the current notes into memos, notes and meetings, and filters to each', () => {
    const groups = recordNoteGroups({
      filed: [
        note('memo', { kind: 'memo' }),
        note('loose'),
        note('v1', { supersededBy: 'loose' }),
      ],
      fromMeetings: [note('call'), note('call memo', { kind: 'memo' })],
      mentions: [note('aside')],
    })
    expect(noteFilterCounts(groups)).toEqual({ memo: 1, note: 2, meeting: 2 })
    const ids = (filter: NoteFilter) => {
      const shown = filterNoteGroups(groups, filter)
      return {
        notes: shown.notes.map((n) => n.id),
        meetings: shown.meetings.map((n) => n.id),
        superseded: shown.superseded.map((n) => n.id),
      }
    }
    expect(ids('all')).toEqual({
      notes: ['memo', 'loose', 'aside'],
      meetings: ['call', 'call memo'],
      superseded: ['v1'],
    })
    expect(ids('memo')).toEqual({
      notes: ['memo'],
      meetings: [],
      superseded: [],
    })
    expect(ids('note')).toEqual({
      notes: ['loose', 'aside'],
      meetings: [],
      superseded: [],
    })
    expect(ids('meeting')).toEqual({
      notes: [],
      meetings: ['call', 'call memo'],
      superseded: [],
    })
  })

  it('counts each note once, superseded ones included', () => {
    expect(
      recordNotesCount({
        filed: [{ id: 'a' }, { id: 'b' }],
        fromMeetings: [{ id: 'b' }, { id: 'c' }],
        mentions: [{ id: 'd' }],
      }),
    ).toBe(4)
  })
})

describe('noteExcerpt', () => {
  it('strips the markdown and reads wiki links as their labels', () => {
    expect(
      noteExcerpt(
        '# IC memo\n\n**Strong** founder; see [the deck](https://x.io) and [[Flent|entity:00000000-0000-4000-8000-000000000001]].\n\n- ARR `$1.2M`\n> grew _fast_',
      ),
    ).toBe(
      'IC memo Strong founder; see the deck and Flent. ARR $1.2M grew fast',
    )
  })

  it('cuts at 160 characters and drops the trailing Mentions line', () => {
    const long = 'word '.repeat(80)
    expect(noteExcerpt(long)?.length).toBe(160)
    expect(noteExcerpt('Body.\nMentions: [[Flent|entity:x]]')).toBe('Body.')
  })

  it('is null for a body with no words', () => {
    expect(noteExcerpt('')).toBeNull()
    expect(noteExcerpt('#  \n\n---\n')).toBeNull()
  })
})

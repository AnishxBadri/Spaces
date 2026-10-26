import { Window } from 'happy-dom'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  openRecordTab,
  recordSearch,
  recordTabCounts,
} from '#/lib/records/record-tabs'
import {
  DetailsAddRow,
  PropertyCell,
  PropertyGrid,
  RailGroup,
  RailGroupRow,
  RailSection,
  RecordBody,
  StageStepper,
} from './record-parts.tsx'
import { RecordTabs } from './record-tabs.tsx'

/**
 * A record's body: the 300px rail on bone left — the property grid as
 * label–value rows, then the relationship groups — and the tab head over
 * one view right: Overview first and uncounted, every other tab that holds
 * something counted and an empty one graphite with none.
 */

const win = new Window()

function render(node: ReactNode) {
  const doc = win.document
  doc.body.innerHTML = renderToStaticMarkup(node)
  return doc
}

const classes = (el: { className: string } | null) =>
  (el?.className ?? '').split(/\s+/)

const counts = { notes: 2, interactions: 1, files: 0, history: 7 }

function record(tab: 'overview' | 'notes' | 'files' = 'notes') {
  return render(
    <RecordBody
      groups
      details={
        <>
          <PropertyGrid>
            <PropertyCell label="Founded">2019</PropertyCell>
            <PropertyCell label="Business model">B2B</PropertyCell>
          </PropertyGrid>
          <RailGroup label="Team" count={1} add={(trigger) => trigger}>
            <RailGroupRow>Ishaan</RailGroupRow>
          </RailGroup>
        </>
      }
    >
      <RecordTabs
        label="Vayu Orbital"
        tab={tab}
        counts={counts}
        onTabChange={() => {}}
        panels={{
          overview: <p data-panel="overview">Overview</p>,
          notes: <p data-panel="notes">Notes</p>,
          interactions: <p data-panel="interactions">Interactions</p>,
          files: <p data-panel="files">Files</p>,
          history: <p data-panel="history">History</p>,
        }}
      />
    </RecordBody>,
  )
}

describe('the details slot', () => {
  it('is the one column beside the view: 300px of bone on the left', () => {
    const doc = record()
    const body = doc.querySelector('[data-record-body="details"]')
    const asides = doc.querySelectorAll('aside')
    expect(asides).toHaveLength(1)
    const details = doc.querySelector('aside[aria-label="Details"]')
    expect(details).not.toBeNull()
    expect(classes(details)).toEqual(
      expect.arrayContaining([
        'bg-bone',
        'xl:w-75',
        'p-3',
        'gap-3',
        'xl:border-r',
        'border-hairline',
      ]),
    )
    // Details first, then the view taking the rest.
    expect(body?.firstElementChild).toBe(details)
    const view = details?.nextElementSibling ?? null
    expect(classes(view)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']))
    expect(view?.querySelector('[role="tablist"]')).not.toBeNull()
    expect(details?.querySelector('[role="tablist"]')).toBeNull()
  })

  it('holds the property grid as a ruled box of label–value rows, labels in sans graphite on bone', () => {
    const doc = record()
    const grid = doc.querySelector('[data-property-grid]')
    expect(classes(grid)).not.toContain('md:grid-cols-2')
    expect(classes(grid)).toEqual(
      expect.arrayContaining(['border', 'border-rule']),
    )
    const labels = Array.from(doc.querySelectorAll('[data-property-label]'))
    expect(labels.map((l) => l.textContent)).toEqual([
      'Founded',
      'Business model',
    ])
    for (const l of labels) {
      expect(classes(l)).toEqual(
        expect.arrayContaining([
          'w-28',
          'bg-bone',
          'border-r',
          'border-rule',
          'px-2.5',
          'py-2',
          'text-label',
          'text-graphite',
        ]),
      )
      expect(classes(l)).not.toContain('mono')
      expect(classes(l)).not.toContain('lowercase')
      expect(classes(l)).not.toContain('field-label')
      // A long name wraps, never truncates.
      expect(l.outerHTML).not.toContain('truncate')
      // The value follows in the same row on paper, left-aligned.
      const value = l.nextElementSibling
      expect(classes(value)).toEqual(
        expect.arrayContaining(['bg-paper', 'text-ui']),
      )
      expect(classes(value)).not.toContain('text-right')
      // Rows are separated by a rule.
      expect(classes(l.parentElement)).toEqual(
        expect.arrayContaining(['border-b', 'border-rule']),
      )
    }
  })

  it('draws an empty rail section as its one Name + row, no head and no sentence', () => {
    const doc = render(
      <RailSection label="Spaces" meta="0" empty>
        <DetailsAddRow>Add to a space…</DetailsAddRow>
      </RailSection>,
    )
    const section = doc.querySelector('section')
    expect(section?.getAttribute('aria-label')).toBe('Spaces')
    expect(section?.querySelector('h2')).toBeNull()
    const row = section?.querySelector('[data-empty-row]')
    expect(row?.textContent).toBe('Spaces+')
    expect(section?.textContent).toBe('Spaces+')
  })

  it('heads a relationship group in sans graphite with its + at the right, rows on rules', () => {
    const doc = record()
    const section = doc.querySelector('aside section[aria-label="Team"]')
    const head = section?.querySelector('h2') ?? null
    expect(head?.textContent).toBe('Team')
    expect(classes(head)).toEqual(
      expect.arrayContaining(['text-ui', 'text-graphite']),
    )
    const plus = section?.querySelector('button[aria-label="Add to Team"]')
    expect(plus?.textContent).toBe('+')
    const row = section?.querySelector('li') ?? null
    expect(row?.textContent).toBe('Ishaan')
    expect(classes(row)).toEqual(
      expect.arrayContaining(['border-b', 'border-rule', 'text-foreground']),
    )
  })

  it('draws an empty group as its one Name + row, and nothing with nothing to add', () => {
    const doc = render(
      <>
        <RailGroup label="Spaces" count={0} empty add={(trigger) => trigger} />
        <RailGroup label="Waiting" count={0} empty />
      </>,
    )
    const sections = doc.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].textContent).toBe('Spaces+')
    expect(sections[0].querySelector('[data-empty-row]')).not.toBeNull()
    expect(doc.body.textContent).not.toMatch(/0/)
  })

  it('hints the edit keys under the grid only while a cell has the caret', () => {
    const hint = record().querySelector('[data-edit-hint]')
    expect(hint?.textContent).toBe('↵ save   esc revert   ⇥ next cell')
    expect(classes(hint)).toEqual(
      expect.arrayContaining([
        'hidden',
        'group-has-[:is(input,textarea):focus]/grid:block',
      ]),
    )
  })
})

describe('the tab head', () => {
  it('shows Overview first and uncounted, then the four tabs with their counts, and no Context', () => {
    const doc = record()
    const tabs = Array.from(doc.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent,
    )
    expect(tabs).toEqual([
      'Overview',
      'Notes2',
      'Interactions1',
      'Files',
      'History7',
    ])
    const overview = doc.querySelector('[role="tab"]')
    expect(overview?.hasAttribute('data-empty')).toBe(false)
    expect(classes(overview)).toContain('text-foreground')
    expect(doc.body.textContent).not.toMatch(/Context/)
    const list = doc.querySelector('[role="tablist"]')
    expect(classes(list)).toEqual(
      expect.arrayContaining(['h-11', 'bg-bone', 'sticky', 'md:top-10']),
    )
  })

  it('draws an empty tab graphite with no count, a closed tab with content in ink', () => {
    const tabs = Array.from(record().querySelectorAll('[role="tab"]'))
    const files = tabs.at(3) ?? null
    expect(files?.hasAttribute('data-empty')).toBe(true)
    expect(classes(files)).toContain('text-graphite')
    expect(classes(files)).not.toContain('opacity-50')
    const history = tabs.at(4) ?? null
    expect(history?.getAttribute('aria-selected')).toBe('false')
    expect(classes(history)).toContain('text-foreground')
    expect(classes(history)).not.toContain('text-graphite')
  })

  it('mounts only the open tab’s view', () => {
    const doc = record('files')
    expect(doc.querySelectorAll('[data-panel]')).toHaveLength(1)
    expect(doc.querySelector('[data-panel="files"]')).not.toBeNull()
    expect(doc.querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Files',
    )
  })
})

describe('which tab opens', () => {
  it('reads ?tab= as a deep link and anything else as none', () => {
    expect(recordSearch.parse({ tab: 'files' })).toEqual({ tab: 'files' })
    expect(recordSearch.parse({ tab: 'context' })).toEqual({})
    expect(recordSearch.parse({})).toEqual({})
  })

  it('takes the link, else Overview — no tab is remembered per kind', () => {
    expect(openRecordTab('files')).toBe('files')
    expect(openRecordTab(undefined)).toBe('overview')
    expect(recordSearch.parse({ tab: 'overview' })).toEqual({
      tab: 'overview',
    })
  })

  it('counts what each tab lists', () => {
    expect(
      recordTabCounts({
        notes: {
          filed: [{ id: 'a' }],
          fromMeetings: [],
          mentions: [{ id: 'b' }, { id: 'c' }],
        },
        timeline: [
          { type: 'interaction', kind: 'email', hasAttachments: false },
          { type: 'macro' },
          { type: 'attrs' },
        ],
        documents: [],
      }),
    ).toEqual({ notes: 3, interactions: 1, files: 0, history: 2 })
  })

  it('counts the Interactions tab under its filter', () => {
    const timeline = [
      { type: 'interaction', kind: 'email', hasAttachments: true },
      { type: 'interaction', kind: 'email', hasAttachments: false },
      { type: 'interaction', kind: 'meeting', hasAttachments: false },
      { type: 'macro' },
    ] as const
    const under = (interactionFilter: 'all' | 'email' | 'attachments') =>
      recordTabCounts({
        notes: { filed: [], fromMeetings: [], mentions: [] },
        timeline,
        documents: [],
        interactionFilter,
      })
    expect(under('all').interactions).toBe(3)
    expect(under('email').interactions).toBe(2)
    expect(under('attachments').interactions).toBe(1)
    // History counts what is not an interaction, whatever the filter.
    expect(under('email').history).toBe(1)
  })

  it('counts the Notes tab under its filter, a filed meeting note once under All', () => {
    const notes = {
      filed: [{ id: 'memo' }, { id: 'granola' }],
      fromMeetings: [{ id: 'granola' }, { id: 'write-up' }],
      mentions: [{ id: 'aside' }],
    }
    const under = (
      notesFilter: 'all' | 'filed' | 'meetings' | 'mentions',
    ): number =>
      recordTabCounts({ notes, timeline: [], documents: [], notesFilter }).notes
    expect(under('all')).toBe(4)
    expect(under('filed')).toBe(2)
    expect(under('meetings')).toBe(2)
    expect(under('mentions')).toBe(1)
  })
})

describe('the pipeline stepper', () => {
  it('prints the stage with its days and the stage median', () => {
    const doc = render(
      <StageStepper
        stages={[
          { id: 'lead', label: 'Lead' },
          { id: 'diligence', label: 'Diligence' },
          { id: 'invested', label: 'Invested' },
        ]}
        currentId="diligence"
        days={11}
        median={9}
      />,
    )
    expect(doc.body.textContent).toContain('Diligence 11d · med 9')
  })
})

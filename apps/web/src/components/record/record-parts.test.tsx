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
  RailSection,
  RecordBody,
  StageStepper,
} from './record-parts.tsx'
import { RecordTabs } from './record-tabs.tsx'

/**
 * A record's body: the 320px details column on bone left —
 * the property grid as label–value rows, then the relationship sections —
 * and the tab head over one view right, every tab counted and an empty one
 * grey at 0.
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

function record(tab: 'notes' | 'files' = 'notes') {
  return render(
    <RecordBody
      details={
        <>
          <PropertyGrid>
            <PropertyCell label="Founded">2019</PropertyCell>
            <PropertyCell label="Business model">B2B</PropertyCell>
          </PropertyGrid>
          <RailSection label="Team" meta="1">
            <span>Ishaan</span>
            <DetailsAddRow>Add a person…</DetailsAddRow>
          </RailSection>
        </>
      }
    >
      <RecordTabs
        label="Vayu Orbital"
        tab={tab}
        counts={counts}
        onTabChange={() => {}}
        panels={{
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
  it('is the one column beside the view: 320px of bone on the left', () => {
    const doc = record()
    const body = doc.querySelector('[data-record-body="details"]')
    const asides = doc.querySelectorAll('aside')
    expect(asides).toHaveLength(1)
    const details = doc.querySelector('aside[aria-label="Details"]')
    expect(details).not.toBeNull()
    expect(classes(details)).toEqual(
      expect.arrayContaining(['bg-bone', 'xl:w-80', 'xl:border-r']),
    )
    // Details first, then the view taking the rest.
    expect(body?.firstElementChild).toBe(details)
    const view = details?.nextElementSibling ?? null
    expect(classes(view)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']))
    expect(view?.querySelector('[role="tablist"]')).not.toBeNull()
    expect(details?.querySelector('[role="tablist"]')).toBeNull()
  })

  it('holds the property grid as single label–value rows, labels in lowercase mono', () => {
    const doc = record()
    const grid = doc.querySelector('[data-property-grid]')
    expect(classes(grid)).not.toContain('md:grid-cols-2')
    const labels = Array.from(doc.querySelectorAll('[data-property-label]'))
    expect(labels.map((l) => l.textContent)).toEqual([
      'Founded',
      'Business model',
    ])
    for (const l of labels) {
      expect(classes(l)).toEqual(
        expect.arrayContaining(['mono', 'lowercase', 'text-graphite']),
      )
      expect(classes(l)).not.toContain('field-label')
      // The lane holds `business model` whole; a longer name wraps, never
      // truncates.
      expect(classes(l)).toContain('w-32')
      expect(l.outerHTML).not.toContain('truncate')
      // The value follows in the same row, left-aligned.
      const value = l.nextElementSibling
      expect(classes(value)).not.toContain('text-right')
    }
  })

  it('ends a relationship section on its + composer row', () => {
    const doc = record()
    const section = doc.querySelector('aside section')
    expect(section?.querySelector('h2')?.textContent).toBe('Team')
    const add = section?.lastElementChild
    expect(add?.tagName).toBe('BUTTON')
    expect(add?.textContent).toBe('+Add a person…')
  })
})

describe('the tab head', () => {
  it('shows the four tabs with their counts, and no Context', () => {
    const doc = record()
    const tabs = Array.from(doc.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent,
    )
    expect(tabs).toEqual(['Notes2', 'Interactions1', 'Files0', 'History7'])
    expect(doc.body.textContent).not.toMatch(/Context/)
    const list = doc.querySelector('[role="tablist"]')
    expect(classes(list)).toEqual(
      expect.arrayContaining(['h-11', 'bg-bone', 'sticky', 'md:top-10']),
    )
  })

  it('draws an empty tab graphite at 0, a closed tab with content in ink', () => {
    const tabs = Array.from(record().querySelectorAll('[role="tab"]'))
    const files = tabs.at(2) ?? null
    expect(files?.hasAttribute('data-empty')).toBe(true)
    expect(classes(files)).toContain('text-graphite')
    expect(classes(files)).not.toContain('opacity-50')
    const history = tabs.at(3) ?? null
    expect(history?.getAttribute('aria-selected')).toBe('false')
    expect(classes(history)).toContain('text-foreground')
    expect(classes(history)).not.toContain('text-graphite')
  })

  it('mounts only the open tab’s view', () => {
    const doc = record('files')
    expect(doc.querySelectorAll('[data-panel]')).toHaveLength(1)
    expect(doc.querySelector('[data-panel="files"]')).not.toBeNull()
    expect(doc.querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Files0',
    )
  })
})

describe('which tab opens', () => {
  it('reads ?tab= as a deep link and anything else as none', () => {
    expect(recordSearch.parse({ tab: 'files' })).toEqual({ tab: 'files' })
    expect(recordSearch.parse({ tab: 'context' })).toEqual({})
    expect(recordSearch.parse({})).toEqual({})
  })

  it('takes the link, else the last tab used here, else Notes', () => {
    expect(openRecordTab('files', 'history')).toBe('files')
    expect(openRecordTab(undefined, 'history')).toBe('history')
    expect(openRecordTab(undefined, 'context')).toBe('notes')
    expect(openRecordTab(undefined, null)).toBe('notes')
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

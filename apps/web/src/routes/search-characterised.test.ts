import type { AnyValidator } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { filesSearch } from '#/lib/documents/to-files'
import { modalSearch } from '#/lib/modal-search'
import { holdingSearch } from '#/lib/portfolio/figures'
import { recordSearch } from '#/lib/records/record-tabs'
import { spaceSearch } from '#/lib/spaces/page'
import { Route as AskRoute } from './_app/ask'
import { Route as CompaniesRoute } from './_app/companies'
import { Route as DealsRoute } from './_app/deals'
import { Route as ImportRoute } from './_app/import'
import { Route as ImportBatchRoute } from './_app/import_.$batchId'
import { Route as MeetingsRoute } from './_app/meetings'
import { Route as ObjectListRoute } from './_app/o.$objectSlug'
import { Route as PeopleRoute } from './_app/people'
import { Route as ReviewRoute } from './_app/review'
import { Route as ProviderRoute } from './_app/settings/connections_.$provider'
import { Route as MembersRoute } from './_app/settings/members'
import { Route as UsageRoute } from './_app/settings/usage'
import { Route as TasksRoute } from './_app/tasks'
import { Route as JoinRoute } from './join'
import { Route as LoginRoute } from './login'
import { Route as ResetRoute } from './reset'

/**
 * Every route's `validateSearch`, run the way the router runs it: through
 * its Standard Schema `validate`, whose issues the router throws as a
 * SearchParamError. The verdict is the search the route reads, or REFUSED.
 * Compared strictly: a key present as `undefined` (a caught bad value)
 * and a key left out (never sent) are different searches. Every row was
 * held against the zod schemas before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const ID_UPPER = ID.toUpperCase()
const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const MAX_UPPER = MAX.toUpperCase()
const NIL = '00000000-0000-0000-0000-000000000000'
/** Version nibble 0: not an RFC 9562 UUID. */
const V0 = '0b6ad7a2-6a3e-0c4f-9a43-5d1f1d8b6c11'

const REFUSED = 'REFUSED'

type Rows = ReadonlyArray<readonly [string, unknown, unknown]>

function verdict(validator: AnyValidator, input: unknown): unknown {
  if (
    validator === undefined ||
    typeof validator === 'function' ||
    !('~standard' in validator)
  )
    throw new Error('validateSearch must be a Standard Schema')
  const result = validator['~standard'].validate(input)
  if (result instanceof Promise)
    throw new Error('validateSearch must answer synchronously')
  return result.issues === undefined ? result.value : REFUSED
}

describe('AskRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ['{ thread: ID }', { thread: ID }, { thread: ID }],
    ['{ thread: ID_UPPER }', { thread: ID_UPPER }, { thread: ID_UPPER }],
    ['{ thread: MAX }', { thread: MAX }, { thread: MAX }],
    ['{ thread: MAX_UPPER }', { thread: MAX_UPPER }, { thread: undefined }],
    ['{ thread: NIL }', { thread: NIL }, { thread: NIL }],
    ['{ thread: V0 }', { thread: V0 }, { thread: undefined }],
    ["{ thread: 'nope' }", { thread: 'nope' }, { thread: undefined }],
    ['{ thread: 7 }', { thread: 7 }, { thread: undefined }],
    ['{ thread: null }', { thread: null }, { thread: undefined }],
    ['{ thread: undefined }', { thread: undefined }, { thread: undefined }],
    ["{ thread: ID, stray: 'x' }", { thread: ID, stray: 'x' }, { thread: ID }],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(AskRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('CompaniesRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ view: 'v1' }", { view: 'v1' }, { view: 'v1' }],
    ["{ view: '' }", { view: '' }, { view: '' }],
    ['{ view: 5 }', { view: 5 }, REFUSED],
    ['{ view: null }', { view: null }, REFUSED],
    ['{ view: undefined }', { view: undefined }, { view: undefined }],
    ["{ view: 'v1', stray: 1 }", { view: 'v1', stray: 1 }, { view: 'v1' }],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(CompaniesRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('DealsRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ view: 'v1' }", { view: 'v1' }, { view: 'v1' }],
    ["{ view: '' }", { view: '' }, { view: '' }],
    ['{ view: 5 }', { view: 5 }, REFUSED],
    ['{ view: null }', { view: null }, REFUSED],
    ['{ view: undefined }', { view: undefined }, { view: undefined }],
    ["{ view: 'v1', stray: 1 }", { view: 'v1', stray: 1 }, { view: 'v1' }],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(DealsRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('PeopleRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ view: 'v1' }", { view: 'v1' }, { view: 'v1' }],
    ["{ view: '' }", { view: '' }, { view: '' }],
    ['{ view: 5 }', { view: 5 }, REFUSED],
    ['{ view: null }', { view: null }, REFUSED],
    ['{ view: undefined }', { view: undefined }, { view: undefined }],
    ["{ view: 'v1', stray: 1 }", { view: 'v1', stray: 1 }, { view: 'v1' }],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(PeopleRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('ObjectListRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ view: 'v1' }", { view: 'v1' }, { view: 'v1' }],
    ["{ view: '' }", { view: '' }, { view: '' }],
    ['{ view: 5 }', { view: 5 }, REFUSED],
    ['{ view: null }', { view: null }, REFUSED],
    ['{ view: undefined }', { view: undefined }, { view: undefined }],
    ["{ view: 'v1', stray: 1 }", { view: 'v1', stray: 1 }, { view: 'v1' }],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(
      verdict(ObjectListRoute.options.validateSearch, input),
    ).toStrictEqual(out)
  })
})

describe('ImportRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ object: 'deals' }", { object: 'deals' }, { object: 'deals' }],
    ["{ object: '' }", { object: '' }, { object: '' }],
    [
      "{ object: 'a'.repeat(80) }",
      { object: 'a'.repeat(80) },
      { object: 'a'.repeat(80) },
    ],
    ["{ object: 'a'.repeat(81) }", { object: 'a'.repeat(81) }, REFUSED],
    ['{ object: 3 }', { object: 3 }, REFUSED],
    ['{ object: undefined }', { object: undefined }, { object: undefined }],
    [
      "{ object: 'deals', stray: 1 }",
      { object: 'deals', stray: 1 },
      { object: 'deals' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(ImportRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('ImportBatchRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, { show: 'all', outcome: 'all' }],
    [
      "{ show: 'create' }",
      { show: 'create' },
      { show: 'create', outcome: 'all' },
    ],
    [
      "{ show: 'attach' }",
      { show: 'attach' },
      { show: 'attach', outcome: 'all' },
    ],
    [
      "{ show: 'decide' }",
      { show: 'decide' },
      { show: 'decide', outcome: 'all' },
    ],
    [
      "{ show: 'noland' }",
      { show: 'noland' },
      { show: 'noland', outcome: 'all' },
    ],
    ["{ show: 'bogus' }", { show: 'bogus' }, { show: 'all', outcome: 'all' }],
    ['{ show: 5 }', { show: 5 }, { show: 'all', outcome: 'all' }],
    [
      '{ show: undefined }',
      { show: undefined },
      { show: 'all', outcome: 'all' },
    ],
    ['{ show: null }', { show: null }, { show: 'all', outcome: 'all' }],
    [
      "{ outcome: 'failed' }",
      { outcome: 'failed' },
      { show: 'all', outcome: 'failed' },
    ],
    ["{ outcome: 'x' }", { outcome: 'x' }, { show: 'all', outcome: 'all' }],
    [
      '{ outcome: undefined }',
      { outcome: undefined },
      { show: 'all', outcome: 'all' },
    ],
    [
      "{ show: 'decide', outcome: 'failed', stray: 1 }",
      { show: 'decide', outcome: 'failed', stray: 1 },
      { show: 'decide', outcome: 'failed' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(
      verdict(ImportBatchRoute.options.validateSearch, input),
    ).toStrictEqual(out)
  })
})

describe('MeetingsRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ show: 'all' }", { show: 'all' }, { show: 'all' }],
    ["{ show: 'upcoming' }", { show: 'upcoming' }, { show: 'upcoming' }],
    ["{ show: 'past' }", { show: 'past' }, { show: 'past' }],
    ["{ show: 'bogus' }", { show: 'bogus' }, { show: undefined }],
    ['{ show: 2 }', { show: 2 }, { show: undefined }],
    ['{ show: undefined }', { show: undefined }, { show: undefined }],
    [
      "{ modal: 'meeting', id: ID }",
      { modal: 'meeting', id: ID },
      { modal: 'meeting', id: ID },
    ],
    [
      "{ modal: 'email', id: ID }",
      { modal: 'email', id: ID },
      { modal: 'email', id: ID },
    ],
    [
      "{ modal: 'note', id: ID }",
      { modal: 'note', id: ID },
      { modal: 'note', id: ID },
    ],
    [
      "{ modal: 'task', id: ID }",
      { modal: 'task', id: ID },
      { modal: undefined, id: ID },
    ],
    [
      "{ modal: 'note', id: 'nope' }",
      { modal: 'note', id: 'nope' },
      { modal: 'note', id: undefined },
    ],
    ["{ modal: 'email' }", { modal: 'email' }, { modal: 'email' }],
    ['{ id: ID }', { id: ID }, { id: ID }],
    [
      '{ modal: 3, id: MAX_UPPER }',
      { modal: 3, id: MAX_UPPER },
      { modal: undefined, id: undefined },
    ],
    [
      '{ modal: undefined, id: undefined }',
      { modal: undefined, id: undefined },
      { modal: undefined, id: undefined },
    ],
    [
      "{ show: 'past', modal: 'meeting', id: ID, stray: 1 }",
      { show: 'past', modal: 'meeting', id: ID, stray: 1 },
      { modal: 'meeting', id: ID, show: 'past' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(MeetingsRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('ReviewRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ['{ record: ID }', { record: ID }, { record: ID }],
    ['{ record: ID_UPPER }', { record: ID_UPPER }, { record: ID_UPPER }],
    ['{ record: MAX }', { record: MAX }, { record: MAX }],
    ['{ record: MAX_UPPER }', { record: MAX_UPPER }, { record: undefined }],
    ['{ record: NIL }', { record: NIL }, { record: NIL }],
    ['{ record: V0 }', { record: V0 }, { record: undefined }],
    ["{ record: 'nope' }", { record: 'nope' }, { record: undefined }],
    ['{ record: 7 }', { record: 7 }, { record: undefined }],
    ['{ record: null }', { record: null }, { record: undefined }],
    ['{ record: undefined }', { record: undefined }, { record: undefined }],
    ["{ record: ID, stray: 'x' }", { record: ID, stray: 'x' }, { record: ID }],
    ['{ space: ID }', { space: ID }, { space: ID }],
    ['{ space: MAX_UPPER }', { space: MAX_UPPER }, { space: undefined }],
    ["{ space: 'nope' }", { space: 'nope' }, { space: undefined }],
    ["{ source: 'gmail' }", { source: 'gmail' }, { source: 'gmail' }],
    ["{ source: '' }", { source: '' }, { source: undefined }],
    ["{ source: ' ' }", { source: ' ' }, { source: ' ' }],
    [
      "{ source: 'a'.repeat(100) }",
      { source: 'a'.repeat(100) },
      { source: 'a'.repeat(100) },
    ],
    [
      "{ source: 'a'.repeat(101) }",
      { source: 'a'.repeat(101) },
      { source: undefined },
    ],
    ['{ source: 9 }', { source: 9 }, { source: undefined }],
    ["{ lane: 'all' }", { lane: 'all' }, { lane: 'all' }],
    [
      "{ lane: 'suggestions' }",
      { lane: 'suggestions' },
      { lane: 'suggestions' },
    ],
    ["{ lane: 'duplicates' }", { lane: 'duplicates' }, { lane: 'duplicates' }],
    ["{ lane: 'bogus' }", { lane: 'bogus' }, { lane: undefined }],
    ['{ lane: undefined }', { lane: undefined }, { lane: undefined }],
    [
      "{ record: ID, source: 'gmail', space: ID, lane: 'duplicates' }",
      { record: ID, source: 'gmail', space: ID, lane: 'duplicates' },
      { record: ID, source: 'gmail', space: ID, lane: 'duplicates' },
    ],
    [
      "{ record: 'x', source: '', space: 'y', lane: 'z' }",
      { record: 'x', source: '', space: 'y', lane: 'z' },
      {
        record: undefined,
        source: undefined,
        space: undefined,
        lane: undefined,
      },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(ReviewRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('ProviderRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ tab: 'setup' }", { tab: 'setup' }, { tab: 'setup' }],
    ["{ tab: 'in-use' }", { tab: 'in-use' }, { tab: 'in-use' }],
    ["{ tab: 'bogus' }", { tab: 'bogus' }, REFUSED],
    ['{ tab: 1 }', { tab: 1 }, REFUSED],
    ['{ tab: undefined }', { tab: undefined }, { tab: undefined }],
    [
      "{ tab: 'setup', stray: 1 }",
      { tab: 'setup', stray: 1 },
      { tab: 'setup' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(ProviderRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('MembersRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ['{ invite: true }', { invite: true }, { invite: true }],
    ['{ invite: false }', { invite: false }, { invite: false }],
    ["{ invite: 'true' }", { invite: 'true' }, { invite: undefined }],
    ['{ invite: 1 }', { invite: 1 }, { invite: undefined }],
    ['{ invite: null }', { invite: null }, { invite: undefined }],
    ['{ invite: undefined }', { invite: undefined }, { invite: undefined }],
    [
      '{ invite: true, stray: 1 }',
      { invite: true, stray: 1 },
      { invite: true },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(MembersRoute.options.validateSearch, input)).toStrictEqual(
      out,
    )
  })
})

describe('UsageRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ['{ run: ID }', { run: ID }, { run: ID }],
    ['{ run: ID_UPPER }', { run: ID_UPPER }, { run: ID_UPPER }],
    ['{ run: MAX }', { run: MAX }, { run: MAX }],
    ['{ run: MAX_UPPER }', { run: MAX_UPPER }, REFUSED],
    ['{ run: NIL }', { run: NIL }, { run: NIL }],
    ['{ run: V0 }', { run: V0 }, REFUSED],
    ["{ run: 'nope' }", { run: 'nope' }, REFUSED],
    ['{ run: 7 }', { run: 7 }, REFUSED],
    ['{ run: null }', { run: null }, REFUSED],
    ['{ run: undefined }', { run: undefined }, { run: undefined }],
    ["{ run: ID, stray: 'x' }", { run: ID, stray: 'x' }, { run: ID }],
    ['{ integration: ID }', { integration: ID }, { integration: ID }],
    ['{ integration: MAX_UPPER }', { integration: MAX_UPPER }, REFUSED],
    ["{ integration: 'nope' }", { integration: 'nope' }, REFUSED],
    [
      '{ run: ID, integration: ID }',
      { run: ID, integration: ID },
      { run: ID, integration: ID },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(UsageRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('TasksRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ['{ task: ID }', { task: ID }, { task: ID }],
    ['{ task: ID_UPPER }', { task: ID_UPPER }, { task: ID_UPPER }],
    ['{ task: MAX }', { task: MAX }, { task: MAX }],
    ['{ task: MAX_UPPER }', { task: MAX_UPPER }, { task: undefined }],
    ['{ task: NIL }', { task: NIL }, { task: NIL }],
    ['{ task: V0 }', { task: V0 }, { task: undefined }],
    ["{ task: 'nope' }", { task: 'nope' }, { task: undefined }],
    ['{ task: 7 }', { task: 7 }, { task: undefined }],
    ['{ task: null }', { task: null }, { task: undefined }],
    ['{ task: undefined }', { task: undefined }, { task: undefined }],
    ["{ task: ID, stray: 'x' }", { task: ID, stray: 'x' }, { task: ID }],
    ['{ record: ID }', { record: ID }, { record: ID }],
    ["{ record: 'nope' }", { record: 'nope' }, { record: undefined }],
    ['{ record: MAX_UPPER }', { record: MAX_UPPER }, { record: undefined }],
    [
      '{ task: ID, record: ID }',
      { task: ID, record: ID },
      { task: ID, record: ID },
    ],
    [
      "{ task: 'x', record: 'y' }",
      { task: 'x', record: 'y' },
      { task: undefined, record: undefined },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(TasksRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('JoinRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, { token: '' }],
    ["{ token: 'abc' }", { token: 'abc' }, { token: 'abc' }],
    ["{ token: '' }", { token: '' }, { token: '' }],
    ['{ token: 123 }', { token: 123 }, { token: '' }],
    ['{ token: null }', { token: null }, { token: '' }],
    ['{ token: undefined }', { token: undefined }, { token: '' }],
    [
      "{ token: 'abc', stray: 1 }",
      { token: 'abc', stray: 1 },
      { token: 'abc' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(JoinRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('ResetRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, { token: '' }],
    ["{ token: 'abc' }", { token: 'abc' }, { token: 'abc' }],
    ["{ token: '' }", { token: '' }, { token: '' }],
    ['{ token: 123 }', { token: 123 }, { token: '' }],
    ['{ token: null }', { token: null }, { token: '' }],
    ['{ token: undefined }', { token: undefined }, { token: '' }],
    [
      "{ token: 'abc', stray: 1 }",
      { token: 'abc', stray: 1 },
      { token: 'abc' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(ResetRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('LoginRoute', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ reset: 'done' }", { reset: 'done' }, { reset: 'done' }],
    ["{ from: 'setup' }", { from: 'setup' }, { from: 'setup' }],
    [
      "{ reset: 'done', from: 'setup' }",
      { reset: 'done', from: 'setup' },
      { reset: 'done', from: 'setup' },
    ],
    ["{ reset: '' }", { reset: '' }, { reset: '' }],
    ['{ reset: 5 }', { reset: 5 }, REFUSED],
    ['{ from: true }', { from: true }, REFUSED],
    ['{ reset: undefined }', { reset: undefined }, { reset: undefined }],
    [
      "{ reset: 'done', stray: 1 }",
      { reset: 'done', stray: 1 },
      { reset: 'done' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(LoginRoute.options.validateSearch, input)).toStrictEqual(out)
  })
})

describe('filesSearch', () => {
  const ROWS: Rows = [
    ['{}', {}, { filed: 'all' }],
    ["{ filed: 'all' }", { filed: 'all' }, { filed: 'all' }],
    ["{ filed: 'unfiled' }", { filed: 'unfiled' }, { filed: 'unfiled' }],
    ["{ filed: 'nonsense' }", { filed: 'nonsense' }, { filed: 'all' }],
    ['{ filed: 1 }', { filed: 1 }, { filed: 'all' }],
    ['{ filed: undefined }', { filed: undefined }, { filed: 'all' }],
    ['{ filed: null }', { filed: null }, { filed: 'all' }],
    ["{ view: 'v1' }", { view: 'v1' }, { filed: 'all', view: 'v1' }],
    ['{ view: 2 }', { view: 2 }, REFUSED],
    [
      '{ view: undefined }',
      { view: undefined },
      { filed: 'all', view: undefined },
    ],
    [
      "{ filed: 'unfiled', view: 'v1', stray: 1 }",
      { filed: 'unfiled', view: 'v1', stray: 1 },
      { filed: 'unfiled', view: 'v1' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(filesSearch, input)).toStrictEqual(out)
  })
})

describe('holdingSearch', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ asOf: '2025-06-30' }", { asOf: '2025-06-30' }, { asOf: '2025-06-30' }],
    ["{ asOf: '2025-6-30' }", { asOf: '2025-6-30' }, { asOf: undefined }],
    ["{ asOf: 'yesterday' }", { asOf: 'yesterday' }, { asOf: undefined }],
    [
      "{ asOf: '2025-06-30T00:00:00Z' }",
      { asOf: '2025-06-30T00:00:00Z' },
      { asOf: undefined },
    ],
    ["{ asOf: ' 2025-06-30' }", { asOf: ' 2025-06-30' }, { asOf: undefined }],
    ["{ asOf: '9999-99-99' }", { asOf: '9999-99-99' }, { asOf: '9999-99-99' }],
    ['{ asOf: 20250630 }', { asOf: 20250630 }, { asOf: undefined }],
    ['{ asOf: null }', { asOf: null }, { asOf: undefined }],
    ['{ asOf: undefined }', { asOf: undefined }, { asOf: undefined }],
    [
      "{ asOf: '2025-06-30', stray: 1 }",
      { asOf: '2025-06-30', stray: 1 },
      { asOf: '2025-06-30' },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(holdingSearch, input)).toStrictEqual(out)
  })
})

describe('recordSearch', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ tab: 'overview' }", { tab: 'overview' }, { tab: 'overview' }],
    ["{ tab: 'notes' }", { tab: 'notes' }, { tab: 'notes' }],
    [
      "{ tab: 'interactions' }",
      { tab: 'interactions' },
      { tab: 'interactions' },
    ],
    ["{ tab: 'files' }", { tab: 'files' }, { tab: 'files' }],
    ["{ tab: 'history' }", { tab: 'history' }, { tab: 'history' }],
    ["{ tab: 'context' }", { tab: 'context' }, { tab: undefined }],
    ['{ tab: 4 }', { tab: 4 }, { tab: undefined }],
    ['{ tab: undefined }', { tab: undefined }, { tab: undefined }],
    [
      "{ modal: 'meeting', id: ID }",
      { modal: 'meeting', id: ID },
      { modal: 'meeting', id: ID },
    ],
    [
      "{ modal: 'email', id: ID }",
      { modal: 'email', id: ID },
      { modal: 'email', id: ID },
    ],
    [
      "{ modal: 'note', id: ID }",
      { modal: 'note', id: ID },
      { modal: 'note', id: ID },
    ],
    [
      "{ modal: 'task', id: ID }",
      { modal: 'task', id: ID },
      { modal: undefined, id: ID },
    ],
    [
      "{ modal: 'note', id: 'nope' }",
      { modal: 'note', id: 'nope' },
      { modal: 'note', id: undefined },
    ],
    ["{ modal: 'email' }", { modal: 'email' }, { modal: 'email' }],
    ['{ id: ID }', { id: ID }, { id: ID }],
    [
      '{ modal: 3, id: MAX_UPPER }',
      { modal: 3, id: MAX_UPPER },
      { modal: undefined, id: undefined },
    ],
    [
      '{ modal: undefined, id: undefined }',
      { modal: undefined, id: undefined },
      { modal: undefined, id: undefined },
    ],
    [
      "{ tab: 'files', modal: 'note', id: ID, stray: 1 }",
      { tab: 'files', modal: 'note', id: ID, stray: 1 },
      { tab: 'files', modal: 'note', id: ID },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(recordSearch, input)).toStrictEqual(out)
  })
})

describe('spaceSearch', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    ["{ tab: 'overview' }", { tab: 'overview' }, { tab: 'overview' }],
    ["{ tab: 'companies' }", { tab: 'companies' }, { tab: 'companies' }],
    ["{ tab: 'notes' }", { tab: 'notes' }, { tab: 'notes' }],
    ["{ tab: 'files' }", { tab: 'files' }, { tab: 'files' }],
    ["{ tab: 'people' }", { tab: 'people' }, { tab: 'people' }],
    ["{ tab: 'records' }", { tab: 'records' }, { tab: 'records' }],
    ["{ tab: 'referenced' }", { tab: 'referenced' }, { tab: undefined }],
    ['{ tab: undefined }', { tab: undefined }, { tab: undefined }],
    ['{ into: ID }', { into: ID }, { into: ID }],
    ['{ into: ID_UPPER }', { into: ID_UPPER }, { into: ID_UPPER }],
    ['{ into: MAX }', { into: MAX }, { into: MAX }],
    ['{ into: MAX_UPPER }', { into: MAX_UPPER }, { into: undefined }],
    ['{ into: NIL }', { into: NIL }, { into: NIL }],
    ['{ into: V0 }', { into: V0 }, { into: undefined }],
    ["{ into: 'nope' }", { into: 'nope' }, { into: undefined }],
    ['{ into: 7 }', { into: 7 }, { into: undefined }],
    ['{ into: null }', { into: null }, { into: undefined }],
    ['{ into: undefined }', { into: undefined }, { into: undefined }],
    ["{ into: ID, stray: 'x' }", { into: ID, stray: 'x' }, { into: ID }],
    ['{ watch: ID }', { watch: ID }, { watch: ID }],
    ['{ watch: MAX_UPPER }', { watch: MAX_UPPER }, { watch: undefined }],
    ["{ watch: 'nope' }", { watch: 'nope' }, { watch: undefined }],
    [
      "{ tab: 'companies', into: ID, watch: ID }",
      { tab: 'companies', into: ID, watch: ID },
      { tab: 'companies', into: ID, watch: ID },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(spaceSearch, input)).toStrictEqual(out)
  })
})

describe('modalSearch', () => {
  const ROWS: Rows = [
    ['{}', {}, {}],
    [
      "{ modal: 'meeting', id: ID }",
      { modal: 'meeting', id: ID },
      { modal: 'meeting', id: ID },
    ],
    [
      "{ modal: 'email', id: ID }",
      { modal: 'email', id: ID },
      { modal: 'email', id: ID },
    ],
    [
      "{ modal: 'note', id: ID }",
      { modal: 'note', id: ID },
      { modal: 'note', id: ID },
    ],
    [
      "{ modal: 'task', id: ID }",
      { modal: 'task', id: ID },
      { modal: undefined, id: ID },
    ],
    [
      "{ modal: 'note', id: 'nope' }",
      { modal: 'note', id: 'nope' },
      { modal: 'note', id: undefined },
    ],
    ["{ modal: 'email' }", { modal: 'email' }, { modal: 'email' }],
    ['{ id: ID }', { id: ID }, { id: ID }],
    [
      '{ modal: 3, id: MAX_UPPER }',
      { modal: 3, id: MAX_UPPER },
      { modal: undefined, id: undefined },
    ],
    [
      '{ modal: undefined, id: undefined }',
      { modal: undefined, id: undefined },
      { modal: undefined, id: undefined },
    ],
    [
      "{ modal: 'note', id: ID, stray: 1 }",
      { modal: 'note', id: ID, stray: 1 },
      { modal: 'note', id: ID },
    ],
  ]
  it.each(ROWS)('%s', (_, input, out) => {
    expect(verdict(modalSearch, input)).toStrictEqual(out)
  })
})

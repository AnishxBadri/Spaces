import type { ConditionValue } from './filter'

/**
 * The one table both evaluators are judged against (SPA-40). `filter.ts`
 * decided the semantics of a view condition in the browser; `compileConditions`
 * (`apps/web/src/lib/views/sql.ts`) decides them again in Postgres, and the
 * only way the second stays the first is a shared fixture list plus a property
 * test that walks every op against every type.
 *
 * It lives here, beside the matcher, as pure data: core imports nothing that
 * reads a database, so the SQL side reads this list across the package
 * boundary rather than the other way round.
 *
 * Read the table column-wise. Each attribute carries one cell per row, so the
 * eight rows are eight *profiles* of the same shape — a full row, a row of
 * empties, a row with the key absent entirely, a row of JSON nulls, values
 * stored as strings (money is `numeric` → a string, CLAUDE.md), an
 * upper-cased/unparseable row, a whitespace-padded row, and a negative one.
 * `undefined` means the key is not in the object at all, which is the trap the
 * SQL side gets wrong by default: `values->'x'` is SQL NULL for both a missing
 * key and a stored JSON null, and `filter.ts` treats them alike only because
 * `isEmpty` covers both.
 */

/** What a fixture cell may hold — JSON, plus `undefined` for "key absent". */
export type FixtureCell =
  string | number | boolean | null | Array<string> | undefined

export type FilterFixtureAttribute = {
  slug: string
  /** An attribute type as the registry spells it; `opsFor` reads this. */
  type: string
  /** One cell per row of `FILTER_FIXTURE_ROW_KEYS`, in order. */
  cells: Array<FixtureCell>
  /** Values worth comparing against for this type, in the property test. */
  probes: Array<ConditionValue>
}

/** The eight profiles, in cell order. */
export const FILTER_FIXTURE_ROW_KEYS = [
  'full',
  'blank',
  'absent',
  'nulls',
  'strings',
  'upper',
  'padded',
  'negative',
] as const

/**
 * One attribute per branch of `opsFor`, and every type it names: the five
 * text types, the three numeric ones, date, checkbox, the three option types,
 * both reference types, and one type the registry has never heard of, which
 * lands on the fallback op list.
 */
export const FILTER_FIXTURE_ATTRIBUTES: Array<FilterFixtureAttribute> = [
  {
    slug: 'note',
    type: 'text',
    cells: [
      'Hyperspectral imaging',
      '',
      undefined,
      null,
      'seed round',
      'SEED',
      '  ',
      'imaging',
    ],
    probes: ['seed', 'SEED', 'imaging', '', null],
  },
  {
    slug: 'site',
    type: 'url',
    cells: [
      'https://alpha.example',
      '',
      undefined,
      null,
      'http://seed.example',
      'HTTPS://B.EXAMPLE',
      ' ',
      'https://c.example',
    ],
    probes: ['https', 'example', '', null],
  },
  {
    slug: 'contact',
    type: 'email',
    cells: [
      'a@alpha.example',
      '',
      undefined,
      null,
      'b@seed.example',
      'C@B.EXAMPLE',
      ' ',
      'd@c.example',
    ],
    probes: ['@b.example', 'a@alpha.example', null],
  },
  {
    slug: 'phone',
    type: 'phone',
    cells: [
      '+1 415 555 0100',
      '',
      undefined,
      null,
      '4155550101',
      '+1 (415) 555-0102',
      ' ',
      '0103',
    ],
    probes: ['555', '0103', '', null],
  },
  {
    slug: 'domain',
    type: 'domain',
    cells: [
      'alpha.example',
      '',
      undefined,
      null,
      'seed.example',
      'B.EXAMPLE',
      ' ',
      'c.example',
    ],
    probes: ['example', 'b.example', null],
  },
  {
    slug: 'score',
    type: 'number',
    cells: [4, 0, undefined, null, '12', 'abc', ' 7 ', -3],
    probes: [4, '12', 0, 'abc', null, -3],
  },
  {
    // Money is drizzle `numeric` → a string in JS (CLAUDE.md), so a currency
    // attribute is the one that most often holds a *string* number.
    slug: 'valuation',
    type: 'currency',
    cells: ['1500000', 0, undefined, null, '-2.5', 'n/a', ' ', '900'],
    probes: [1500000, '900', 0, null],
  },
  {
    slug: 'stars',
    type: 'rating',
    cells: [5, 0, undefined, null, '3', 1, 2, 4],
    probes: [3, 5, 0, '1', null],
  },
  {
    // Dates are ISO strings compared lexically (CLAUDE.md), which is why the
    // cells never vary in shape: same length, same separators.
    slug: 'founded',
    type: 'date',
    cells: [
      '2021-03-01',
      '',
      undefined,
      null,
      '2023-07-04',
      '2019-12-31',
      '2020-01-01',
      '2024-11-30',
    ],
    probes: ['2021-03-01', '2020-06-01', '', null],
  },
  {
    slug: 'active',
    type: 'checkbox',
    cells: [true, false, undefined, null, 'yes', false, 0, true],
    probes: [true, false, null],
  },
  {
    slug: 'stage',
    type: 'select',
    cells: [
      'seed',
      '',
      undefined,
      null,
      'seed',
      'growth',
      'series-a',
      'growth',
    ],
    probes: ['seed', 'growth', '', null],
  },
  {
    slug: 'status',
    type: 'status',
    cells: ['live', '', undefined, null, 'live', 'paused', 'live', 'closed'],
    probes: ['live', 'closed', null],
  },
  {
    // Multi-valued: "is X" means X is *among* the values, which is the whole
    // reason the SQL side is handed the jsonb value and not `values->>'tags'`.
    slug: 'tags',
    type: 'multi_select',
    cells: [['a', 'b'], [], undefined, null, ['b'], ['a'], ['a', 'c'], ['c']],
    probes: ['a', 'b', 'z', ['a'], null],
  },
  {
    slug: 'partner',
    type: 'record_reference',
    cells: ['e1', '', undefined, null, 'e1', 'e2', 'e3', 'e2'],
    probes: ['e1', 'e9', null],
  },
  {
    slug: 'owner',
    type: 'actor_reference',
    cells: ['u1', '', undefined, null, 'u2', 'u1', 'u3', 'u2'],
    probes: ['u1', 'u9', null],
  },
  {
    // Not a registry type — `opsFor` falls back, and the cells are deliberately
    // heterogeneous so `String(v)` (array join included) is pinned too.
    slug: 'misc',
    type: 'json',
    cells: ['x', '', undefined, null, 'seed', ['a', 'b'], 0, true],
    probes: ['x', 'a,b', 'true', 0, null],
  },
]

export type FilterFixtureRow = {
  key: string
  values: Record<string, Exclude<FixtureCell, undefined>>
}

/** The table read row-wise: what one record's `values` jsonb would hold. */
export const FILTER_FIXTURE_ROWS: Array<FilterFixtureRow> =
  FILTER_FIXTURE_ROW_KEYS.map((key, i) => {
    const values: Record<string, Exclude<FixtureCell, undefined>> = {}
    for (const a of FILTER_FIXTURE_ATTRIBUTES) {
      const cell = a.cells[i]
      if (cell !== undefined) values[a.slug] = cell
    }
    return { key, values }
  })

/** The registry the two evaluators share: slug → type, archived excluded. */
export const fixtureTypeOf = (slug: string): string | undefined =>
  FILTER_FIXTURE_ATTRIBUTES.find((a) => a.slug === slug)?.type

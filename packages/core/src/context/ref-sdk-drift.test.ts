import { describe, expect, it } from 'vitest'
import type { Ref } from '@spaces/sdk'
import { parseRef, ref } from './ref'
import type { ParsedRef } from './ref'

/**
 * `@spaces/sdk`'s `Ref` is a hand copy of this directory's D4 grammar — the
 * SDK cannot import core, so the two are held together here, where core may
 * import the SDK (checkpoint review of PR #4, 2026-10-01). Both directions:
 * every SDK shape parses as the kind it names, and every kind core's parser
 * knows has an SDK shape. A kind added on one side only fails this file — at
 * typecheck through the mapped type, and at run time through the key lists.
 */

/** The kinds the SDK's template literals spell, read off the type. */
type SdkKind = Ref extends `${infer K}:${string}` ? K : never

/** One ref per SDK shape, each typed as that shape alone. */
const SDK_REFS: { readonly [K in SdkKind]: Extract<Ref, `${K}:${string}`> } = {
  attr: 'attr:6f2c1a2b-0000-4000-8000-000000000001:funding_stage',
  note: 'note:6f2c1a2b-0000-4000-8000-000000000002',
  memo: 'memo:6f2c1a2b-0000-4000-8000-000000000003',
  doc: 'doc:6f2c1a2b-0000-4000-8000-000000000004#3',
  event: 'event:6f2c1a2b-0000-4000-8000-000000000005',
  interaction: 'interaction:6f2c1a2b-0000-4000-8000-000000000006',
  task: 'task:6f2c1a2b-0000-4000-8000-000000000007',
  mandate: 'mandate:6f2c1a2b-0000-4000-8000-000000000008',
  term: 'term:6f2c1a2b-0000-4000-8000-000000000009',
}

/**
 * Every kind core's parser can return, listed once — the mapped type makes
 * a kind added to `ParsedRef` a compile error here until it is named, and
 * the test then fails until the SDK has a shape for it.
 */
const CORE_KINDS: { readonly [K in ParsedRef['kind']]: true } = {
  attr: true,
  note: true,
  memo: true,
  doc: true,
  event: true,
  interaction: true,
  task: true,
  mandate: true,
  term: true,
}

/** `true` while every core kind is an SDK kind; `false` stops this compiling. */
const coreKindsCovered: [Exclude<ParsedRef['kind'], SdkKind>] extends [never]
  ? true
  : false = true

describe('the SDK’s Ref and core’s ref grammar', () => {
  it.each(Object.entries(SDK_REFS))(
    'core parses the SDK’s %s shape as that kind',
    (kind, sdkRef) => {
      expect(parseRef(sdkRef)?.kind).toBe(kind)
    },
  )

  it('every kind core’s parser knows has an SDK shape, and no more', () => {
    expect(coreKindsCovered).toBe(true)
    expect(Object.keys(SDK_REFS).sort()).toEqual(Object.keys(CORE_KINDS).sort())
    // The builder covers the same kinds — nothing formats a ref by hand.
    expect(Object.keys(ref).sort()).toEqual(Object.keys(CORE_KINDS).sort())
  })
})

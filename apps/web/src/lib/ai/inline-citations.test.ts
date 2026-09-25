import { describe, expect, it } from 'vitest'
import { inlineCitations } from './inline-citations'

/** SPA-66. Refs → the words a note keeps. Pure; no database. */

const D = '11111111-1111-4111-8111-111111111111'
const N = '22222222-2222-4222-8222-222222222222'

const labels = new Map([
  [`doc:${D}#3`, 'dd_pack.pdf, p.4'],
  [`doc:${D}#4`, 'dd_pack.pdf, p.5'],
  [`note:${N}`, 'Call notes'],
])

describe('inlineCitations', () => {
  it('writes a cited ref as its label, escaped for markdown', () => {
    const r = inlineCitations(`ARR is $1.2M [doc:${D}#3].`, labels)
    expect(r.markdown).toBe('ARR is $1.2M (dd\\_pack.pdf, p.4).')
    expect(r.cited).toEqual([`doc:${D}#3`])
  })

  it('reads a list in one bracket, comma or semicolon separated', () => {
    const r = inlineCitations(
      `Growth [doc:${D}#3, doc:${D}#4; note:${N}]`,
      labels,
    )
    expect(r.markdown).toBe(
      'Growth (dd\\_pack.pdf, p.4; dd\\_pack.pdf, p.5; Call notes)',
    )
    expect(r.cited).toEqual([`doc:${D}#3`, `doc:${D}#4`, `note:${N}`])
  })

  it('drops a ref the context did not carry, and an emptied bracket with its space', () => {
    const r = inlineCitations(
      `Made up [doc:${D}#99]. Half [doc:${D}#99, note:${N}].`,
      labels,
    )
    expect(r.markdown).toBe('Made up. Half (Call notes).')
    expect(r.cited).toEqual([`note:${N}`])
  })

  it('leaves links and brackets that are not refs alone', () => {
    const md = 'See [the site](https://x.example) and [p.4] and [TBD]'
    expect(inlineCitations(md, labels)).toEqual({ markdown: md, cited: [] })
  })
})

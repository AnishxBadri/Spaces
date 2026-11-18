import { describe, expect, it } from 'vitest'
import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import { defaultAttributeOrder } from './default-order'

/**
 * Reset to default order: the system attributes by the registry, the
 * custom ones after them in the order they hold now.
 */

const sys = (slug: string) => ({ id: `sys:${slug}`, slug, isSystem: true })
const own = (slug: string) => ({ id: `own:${slug}`, slug, isSystem: false })

describe('defaultAttributeOrder', () => {
  it('leads with the registry’s system attributes, identity and contact first', () => {
    // An older install: identity and contact below what came after them.
    const current = [
      own('thesis'),
      sys('description'),
      sys('founders'),
      sys('location'),
      own('fund_size'),
      sys('linkedin'),
      sys('domains'),
      sys('funding_stage'),
    ]
    expect(defaultAttributeOrder('company', current)).toEqual([
      'sys:domains',
      'sys:linkedin',
      'sys:funding_stage',
      'sys:location',
      'sys:description',
      'sys:founders',
      'own:thesis',
      'own:fund_size',
    ])
  })

  it('follows SYSTEM_ATTRIBUTES exactly when every one is present', () => {
    const slugs = SYSTEM_ATTRIBUTES.person.map((d) => d.slug)
    const current = [...slugs].reverse().map(sys)
    expect(defaultAttributeOrder('person', current)).toEqual(
      slugs.map((s) => `sys:${s}`),
    )
  })

  it('keeps a system attribute the registry no longer names after the listed ones', () => {
    const current = [sys('legacy'), own('notes'), sys('stage'), sys('value')]
    expect(defaultAttributeOrder('deal', current)).toEqual([
      'sys:value',
      'sys:stage',
      'sys:legacy',
      'own:notes',
    ])
  })

  it('places a custom attribute that shares a system slug with the custom ones', () => {
    const current = [own('value'), sys('value')]
    expect(defaultAttributeOrder('deal', current)).toEqual([
      'sys:value',
      'own:value',
    ])
  })
})

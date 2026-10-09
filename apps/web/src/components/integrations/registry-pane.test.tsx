import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AvailablePlugin } from '#/lib/server-fns'
import { RegistryPane, UploadPlugin } from './registry-pane'

/**
 * Upload a plugin, rendered the way the server renders it: one outline
 * button in the page head, and a hidden picker that takes the release's
 * `.tgz` and its `.json` entry together.
 */

const render = (pending: boolean, disabled: boolean) =>
  renderToStaticMarkup(
    <UploadPlugin pending={pending} disabled={disabled} onUpload={() => {}} />,
  )

describe('UploadPlugin', () => {
  it('offers one button and a picker for the tarball and its entry', () => {
    const html = render(false, false)
    expect(html).toContain('>Upload a plugin</button>')
    expect(html).toContain('type="file"')
    expect(html).toContain('multiple=""')
    expect(html).toContain('accept=".tgz,.json"')
    expect(html).not.toContain('disabled=""')
  })

  it('says it is uploading, and waits while any install is in flight', () => {
    expect(render(true, true)).toContain('>Uploading</button>')
    expect(render(false, true)).toContain('disabled=""')
  })
})

/**
 * Available, rendered the way the server renders it: tabs by job with a
 * count each, Other only when an entry names no role, every offered plugin
 * under All with its Install.
 */
const plugin = (
  pluginId: string,
  roles: AvailablePlugin['roles'],
): AvailablePlugin => ({
  pluginId,
  name: pluginId.charAt(0).toUpperCase() + pluginId.slice(1),
  description: `The ${pluginId} plugin.`,
  version: '0.1.0',
  roles,
  needs: 'no key',
})

const pane = (available: Array<AvailablePlugin>, disabled = false) =>
  renderToStaticMarkup(
    <RegistryPane
      view={{ available, error: null }}
      pending={null}
      disabled={disabled}
      onInstall={() => {}}
    />,
  )

/** Each tab as `label count`, in order. */
const tabsOf = (html: string) =>
  [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )

describe('RegistryPane', () => {
  it('groups the registry by job, a count on each tab, every plugin under All', () => {
    const html = pane([
      plugin('airtable', ['import']),
      plugin('rss', ['feeds']),
      plugin('m365', ['email-calendar', 'files']),
    ])
    expect(html).toContain('Available')
    expect(tabsOf(html)).toEqual([
      'All 3',
      'Email &amp; calendar 1',
      'Files 1',
      'Import 1',
      'Feeds 1',
    ])
    expect(html.match(/data-plugin=/g)).toHaveLength(3)
    expect(html).toContain('>Import<')
    expect(html).toContain('>Email &amp; calendar · Files<')
    expect(html.match(/>Install<\/button>/g)).toHaveLength(3)
  })

  it('opens an Other tab only when an entry names no role', () => {
    expect(tabsOf(pane([plugin('rss', ['feeds'])]))).toEqual([
      'All 1',
      'Feeds 1',
    ])
    const html = pane([plugin('rss', ['feeds']), plugin('legacy', [])])
    expect(tabsOf(html)).toEqual(['All 2', 'Feeds 1', 'Other 1'])
    expect(html).toContain('>Other<')
  })

  it('lets a member read every tab but install nothing', () => {
    const html = pane([plugin('rss', ['feeds'])], true)
    expect(html).not.toMatch(/role="tab"[^>]*disabled=""/)
    expect(html).toMatch(/disabled=""[^>]*>Install<\/button>/)
  })
})

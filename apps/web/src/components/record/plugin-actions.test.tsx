import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PluginActions } from './plugin-actions.tsx'

/**
 * The record head's plugin controls: one outline button per action the loader
 * handed it, labelled as the manifest declares, and nothing at all when no
 * runnable plugin declares one on this kind. (D63)
 */

const enrich = {
  integrationId: 'f1f0b6f2-7c1e-4f0a-9d2a-000000000001',
  pluginId: 'apollo',
  pluginName: 'Apollo',
  actionId: 'enrich-company',
  label: 'Enrich',
}

describe('PluginActions', () => {
  it('renders the declared action as a record-head button', () => {
    const html = renderToStaticMarkup(
      <PluginActions
        entityId="f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa"
        actions={[enrich]}
      />,
    )
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('>Enrich</button>')
    expect(html).toContain('data-variant="outline"')
    expect(html).toContain('title="Enrich with Apollo"')
  })

  it('renders nothing when no plugin offers an action', () => {
    expect(
      renderToStaticMarkup(
        <PluginActions
          entityId="f1f0b6f2-7c1e-4f0a-9d2a-0000000000aa"
          actions={[]}
        />,
      ),
    ).toBe('')
  })
})

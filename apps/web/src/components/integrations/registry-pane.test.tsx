import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UploadPlugin } from './registry-pane'

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

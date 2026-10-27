import { Link } from '@tanstack/react-router'
import { CreateCompanyDialog } from '#/components/create-company-dialog'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { DitherBlock } from '#/components/dither'
import { Button } from '#/components/ui/button'
import { openUploadDialog } from '#/lib/upload-dialog-store'

/**
 * Today in a workspace with no companies: the empty-state block with the
 * three ways in, and nothing else. It goes once a company exists; there is
 * nothing to tick or dismiss.
 */
export function FirstRun({ registry }: { registry: Array<RegistryEntry> }) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-16">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <DitherBlock tone="ink" />
        <h2 className="font-serif text-xl leading-6 font-semibold">
          Bring in what you already have.
        </h2>
        <div className="flex flex-wrap items-start justify-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <Button asChild>
              <Link to="/import">Import a file</Link>
            </Button>
            <span className="mono text-micro text-graphite">
              CSV or Airtable export
            </span>
          </div>
          <Button variant="outline" onClick={openUploadDialog}>
            Drop a deck
          </Button>
          <CreateCompanyDialog
            registry={registry}
            trigger={<Button variant="outline">Add a company</Button>}
          />
        </div>
      </div>
    </div>
  )
}

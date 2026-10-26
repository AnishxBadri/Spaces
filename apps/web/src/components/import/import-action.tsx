import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '#/components/ui/button'
import type { ListVerb } from '#/components/table/list-menu'

/**
 * The `Import` action an object list page carries in its header's action
 * slot. It opens the wizard with the object already picked.
 */
export function ImportAction({ objectSlug }: { objectSlug: string }) {
  return (
    <Button variant="outline" asChild>
      <Link to="/import" search={{ object: objectSlug }}>
        Import
      </Link>
    </Button>
  )
}

/** `Import…` in a list head's `···`: the wizard, the object already picked. */
export function useImportVerb(objectSlug: string): ListVerb {
  const navigate = useNavigate()
  return {
    label: 'Import…',
    onSelect: () =>
      void navigate({ to: '/import', search: { object: objectSlug } }),
  }
}

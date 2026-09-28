import { Link } from '@tanstack/react-router'
import { Button } from '#/components/ui/button'

/**
 * The `Import` action an object list page carries in its header's action
 * slot (SPA-164). It opens the wizard with the object already picked.
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

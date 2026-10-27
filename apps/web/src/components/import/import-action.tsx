import { useNavigate } from '@tanstack/react-router'
import type { ListVerb } from '#/components/table/list-menu'

/** `Import…` in a list head's `···`: the wizard, the object already picked. */
export function useImportVerb(objectSlug: string): ListVerb {
  const navigate = useNavigate()
  return {
    label: 'Import…',
    onSelect: () =>
      void navigate({ to: '/import', search: { object: objectSlug } }),
  }
}

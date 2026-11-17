import { useNavigate } from '@tanstack/react-router'
import { icon } from '#/components/icons'
import type { ListVerb } from '#/components/table/list-menu'

/** `Import…` in a list head's `···`: the wizard, the object already picked. */
export function useImportVerb(objectSlug: string): ListVerb {
  const navigate = useNavigate()
  return {
    label: 'Import…',
    icon: <icon.import />,
    onSelect: () =>
      void navigate({ to: '/import', search: { object: objectSlug } }),
  }
}

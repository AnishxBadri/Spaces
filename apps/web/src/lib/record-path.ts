/**
 * Where a record lives, by entity kind. Custom records need their object's
 * slug — every list that links to records carries it. Null means "no page"
 * (documents, terms), never a broken link.
 */
export function recordPath(row: {
  kind: string
  id: string
  objectSlug?: string | null
}): string | null {
  switch (row.kind) {
    case 'company':
    case 'organization':
      return `/companies/${row.id}`
    case 'person':
      return `/people/${row.id}`
    case 'deal':
      return `/deals/${row.id}`
    case 'space':
      return `/spaces/${row.id}`
    case 'note':
      return `/notes/${row.id}`
    case 'custom':
      return row.objectSlug ? `/o/${row.objectSlug}/${row.id}` : null
    default:
      return null
  }
}

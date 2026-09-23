/**
 * Where a record lives, by entity kind. Custom records need their object's
 * slug — every list that links to records carries it. Null means "no page"
 * (documents), never a broken link. A term's page is its concept node
 * (SPA-75): definition, mentions, and what they reach.
 */
export function recordPath(row: {
  kind: string
  id: string
  objectSlug?: string | null
}): string | null {
  switch (row.kind) {
    case 'company':
      return `/companies/${row.id}`
    case 'person':
      return `/people/${row.id}`
    case 'deal':
      return `/deals/${row.id}`
    case 'space':
      return `/spaces/${row.id}`
    case 'note':
      return `/notes/${row.id}`
    case 'term':
      return `/terms/${row.id}`
    case 'custom':
      return row.objectSlug ? `/o/${row.objectSlug}/${row.id}` : null
    default:
      return null
  }
}

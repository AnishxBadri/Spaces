import { DOCUMENT_KINDS, DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import type { ShelfDocument } from '#/lib/documents/shelf'

/**
 * The **document surface registry** (docsurf-12b, SPA-141) — the field list
 * `/documents` filters by.
 *
 * ## Why it is synthetic, and why that is legitimate
 *
 * Everywhere else in this codebase a registry is rows of the `attribute`
 * table: an object's attributes, read off the database, evaluated against a
 * record's `entity.values`. A document has none of that — no object row, no
 * attribute rows, no `entity.values`. Its fields are **columns** (`kind`,
 * `extraction_status`, `source_class`) and **edges** (`link(tagged_in)`,
 * `entity_space`). So there is nothing to generate a registry from, and the
 * shelf would be the one list in the app that cannot express a filter.
 *
 * The answer is that a shelf is a **surface** (D2, 2026-09-23 — `view.surface`
 * is `document` here and `object_id` is null), and admitting a surface means
 * bringing its own field list with it. This module is the registry half of
 * that admission: hand-declared `RegistryEntry` rows, in code, in one place,
 * so that `ViewBar`'s condition editor and `matchesConditions` get exactly
 * the shape they already take and gain no new code path. A second shelf takes
 * a second list beside this one — never a migration, and never an `attribute`
 * row in the database for a thing that has no records.
 *
 * `RegistryEntry` is `components/attributes/value-editor.tsx`'s own type, not
 * a look-alike: the popover renders a condition's value through `ValueEditor`,
 * so an entry that merely resembled one would render the wrong control.
 *
 * ## Why `space` and `filed_against` are selects and not `record_reference`
 *
 * Both are reference-shaped in the filter model — `opsFor('select')` and
 * `opsFor('record_reference')` are the same four ops, and `matchesCondition`
 * compares an id against a list of ids either way. They differ only in the
 * control, and `record_reference` is the wrong control here for two reasons.
 * Its picker (`RecordRefPicker`) searches one `targetKind`, and `targetKind`
 * is `ObjectKind` — `company | person | deal` — so a space is not expressible
 * by it at all; and the popover passes no `refNames`, so a saved reference
 * condition would read back as `…` rather than as the name that was picked.
 *
 * What the editor **already does** for the space picker on records is a
 * select over a live list (`SpacePicker` in `components/record-files.tsx`,
 * over `listSpaces()`), and that is what these two are: a select whose
 * options `documentRegistry()` fills from the rows the shelf loaded. Filling
 * from the loaded rows rather than from the whole workspace is deliberate —
 * the shelf is unpaged and evaluation is client-side, so an option drawn from
 * anywhere else could only ever match nothing.
 */

/** The four extraction states, in the words the Extraction column prints. */
export const DOCUMENT_EXTRACTION_LABELS: Record<
  ShelfDocument['extractionStatus'],
  string
> = {
  pending: 'extracting…',
  done: 'extracted',
  unsupported: 'no text layer',
  failed: 'failed',
}

/**
 * The two classes a *document* can carry. `source_class` has eight values,
 * but `document_source_ref_invariant` plus the lanes that write documents
 * leave exactly these two — upload, url and clip are all a person in a
 * surface we ship (`manual`), and a connector's file is `integration` plus
 * the row that names it. The words match the Source column's own.
 */
export const DOCUMENT_ORIGIN_LABELS: Record<string, string> = {
  manual: 'Upload',
  integration: 'Integration',
}

/**
 * The slugs, spelled once. They are the keys of the projection
 * (`lib/documents/project.ts`) and the `slug` of a stored condition, so a
 * rename here is a rename of saved views — FROZEN, like a table prefs key.
 */
export const DOCUMENT_FIELD_SLUGS = {
  kind: 'kind',
  extraction: 'extraction',
  origin: 'origin',
  space: 'space',
  filedAgainst: 'filed_against',
  filed: 'filed',
} as const

/**
 * The surface's fields. `isSystem` is true on all six: none of them is a
 * user-defined attribute and none can be archived or deleted, which is what
 * the flag means everywhere else.
 *
 * `space` and `filed_against` ship with an empty option list; the live one
 * comes from `documentRegistry()`. Held as a module constant so a page that
 * never opens the popover still hands `ViewBar` a stable array.
 */
export const DOCUMENT_REGISTRY: Array<RegistryEntry> = [
  {
    slug: DOCUMENT_FIELD_SLUGS.kind,
    name: 'Kind',
    type: 'select',
    isSystem: true,
    options: {
      options: DOCUMENT_KINDS.map((id) => ({
        id,
        label: DOCUMENT_KIND_LABELS[id],
      })),
    },
  },
  {
    slug: DOCUMENT_FIELD_SLUGS.extraction,
    name: 'Extraction',
    type: 'select',
    isSystem: true,
    options: {
      options: (['pending', 'done', 'unsupported', 'failed'] as const).map(
        (id) => ({ id, label: DOCUMENT_EXTRACTION_LABELS[id] }),
      ),
    },
  },
  {
    slug: DOCUMENT_FIELD_SLUGS.origin,
    name: 'Source',
    type: 'select',
    isSystem: true,
    options: {
      options: (['manual', 'integration'] as const).map((id) => ({
        id,
        label: DOCUMENT_ORIGIN_LABELS[id] ?? id,
      })),
    },
  },
  {
    slug: DOCUMENT_FIELD_SLUGS.space,
    name: 'Space',
    type: 'select',
    isSystem: true,
    options: { options: [] },
  },
  {
    slug: DOCUMENT_FIELD_SLUGS.filedAgainst,
    name: 'Filed against',
    type: 'select',
    isSystem: true,
    options: { options: [] },
  },
  {
    slug: DOCUMENT_FIELD_SLUGS.filed,
    name: 'Filed',
    type: 'checkbox',
    isSystem: true,
    options: null,
  },
]

/**
 * The type of one field, for `matchesConditions`' third argument. A slug that
 * names none is `undefined`, which is what makes the evaluator **ignore** a
 * condition it cannot type rather than fail every row against it — a view
 * saved against a field that later went away narrows to nothing, not to zero
 * rows.
 */
export function documentFieldType(slug: string): string | undefined {
  return DOCUMENT_REGISTRY.find((d) => d.slug === slug)?.type
}

/** id → label, deduped, sorted by label — one option per entity, not per edge. */
function optionsFrom(
  pairs: Array<{ id: string; name: string }>,
): Array<{ id: string; label: string }> {
  const byId = new Map(pairs.map((p) => [p.id, p.name]))
  return [...byId]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * `DOCUMENT_REGISTRY` with the two edge fields' options filled from the rows
 * on the shelf. Every other entry is returned by reference — the option lists
 * for `kind`, `extraction` and `origin` are fixed by their enums.
 */
export function documentRegistry(
  rows: Array<Pick<ShelfDocument, 'records' | 'spaces'>>,
): Array<RegistryEntry> {
  const spaces = optionsFrom(rows.flatMap((r) => r.spaces))
  const records = optionsFrom(rows.flatMap((r) => r.records))
  return DOCUMENT_REGISTRY.map((d) => {
    if (d.slug === DOCUMENT_FIELD_SLUGS.space)
      return { ...d, options: { options: spaces } }
    if (d.slug === DOCUMENT_FIELD_SLUGS.filedAgainst)
      return { ...d, options: { options: records } }
    return d
  })
}

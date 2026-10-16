import { normalizeName } from '../entities/normalize'
import { guessDocumentKind, guessKindFromFolder } from './index'
import type { DocumentKind } from './index'

/**
 * `resolveItem`: where one item of a bound folder is filed, decided from its
 * name, its parent's target and the lookups the caller made. Pure — the walk
 * reads the database, this decides — so it never creates a record and never
 * calls a model (spec-ai-substrate §11).
 * - Folder names are hints, never identity: a folder under a space lands on
 *   a company only on an exact match; a near one leaves the files where
 *   they are and hands the candidates back.
 * - The kind ladder: the nearest kind folder, else the filename, else `other`.
 */

/** Where files are being filed, and the kind a kind folder preset for them. */
export type ItemTarget = {
  readonly entityKind: 'space' | 'company' | 'deal' | 'record'
  readonly entityId: string
  readonly documentKind: DocumentKind | null
}

/** A record a folder name came close to. */
export type FolderCandidate = {
  readonly entityId: string
  readonly name: string
  readonly score: number
}

/** A folder name against the company names: one exact, close ones, or none. */
export type CompanyMatch =
  | { readonly verdict: 'attach'; readonly entityId: string }
  | {
      readonly verdict: 'fuzzy'
      readonly candidates: ReadonlyArray<FolderCandidate>
    }
  | { readonly verdict: 'no_match' }

/** A deal of the parent company, by its name. */
export type CompanyDeal = { readonly entityId: string; readonly name: string }

/**
 * What a folder's decision reads: the company match when the parent is a
 * space, the company's deals when it is a company (`lookupFor` says which).
 */
export type FolderLookups =
  | { readonly lookup: 'company'; readonly company: CompanyMatch }
  | { readonly lookup: 'deals'; readonly deals: ReadonlyArray<CompanyDeal> }
  | { readonly lookup: 'none' }

export type FolderItem = { readonly kind: 'folder'; readonly name: string }
export type FileItem = { readonly kind: 'file'; readonly name: string }

export type FolderDecision = {
  readonly target: ItemTarget
  /** Close companies a folder under a space did not match exactly. */
  readonly candidates: ReadonlyArray<FolderCandidate>
}

export type FileDecision = {
  readonly target: ItemTarget
  readonly documentKind: DocumentKind
}

/** The lookup a folder under `parent` needs before it can be decided. */
export function lookupFor(
  parent: ItemTarget,
  mapSubfolders: boolean,
): FolderLookups['lookup'] {
  if (!mapSubfolders) return 'none'
  if (parent.entityKind === 'space') return 'company'
  if (parent.entityKind === 'company') return 'deals'
  return 'none'
}

/** The parent's target, a kind folder's preset taking over the inherited one. */
const kindFolder = (parent: ItemTarget, name: string): ItemTarget => ({
  ...parent,
  documentKind: guessKindFromFolder(name) ?? parent.documentKind,
})

/** The one deal whose name equals the folder's, normalised; never fuzzy. */
const dealNamed = (
  deals: ReadonlyArray<CompanyDeal>,
  name: string,
): CompanyDeal | null => {
  const wanted = normalizeName(name)
  if (wanted === '') return null
  const hits = deals.filter((d) => normalizeName(d.name) === wanted)
  return hits.length === 1 ? (hits.at(0) ?? null) : null
}

function resolveFolder(
  item: FolderItem,
  parent: ItemTarget,
  options: { readonly mapSubfolders: boolean; readonly lookups: FolderLookups },
): FolderDecision {
  if (!options.mapSubfolders) return { target: parent, candidates: [] }
  const { lookups } = options
  if (parent.entityKind === 'space') {
    const match = lookups.lookup === 'company' ? lookups.company : null
    if (match?.verdict === 'attach')
      return {
        target: {
          entityKind: 'company',
          entityId: match.entityId,
          documentKind: null,
        },
        candidates: [],
      }
    return {
      target: kindFolder(parent, item.name),
      candidates: match?.verdict === 'fuzzy' ? match.candidates : [],
    }
  }
  if (parent.entityKind === 'company' && lookups.lookup === 'deals') {
    const deal = dealNamed(lookups.deals, item.name)
    if (deal !== null)
      return {
        target: {
          entityKind: 'deal',
          entityId: deal.entityId,
          documentKind: null,
        },
        candidates: [],
      }
  }
  return { target: kindFolder(parent, item.name), candidates: [] }
}

/** A folder's target and any close companies; a file's target and kind. */
export function resolveItem(
  item: FolderItem,
  parent: ItemTarget,
  options: { readonly mapSubfolders: boolean; readonly lookups: FolderLookups },
): FolderDecision
export function resolveItem(item: FileItem, parent: ItemTarget): FileDecision
export function resolveItem(
  item: FolderItem | FileItem,
  parent: ItemTarget,
  options?: {
    readonly mapSubfolders: boolean
    readonly lookups: FolderLookups
  },
): FolderDecision | FileDecision {
  if (item.kind === 'folder')
    return resolveFolder(
      item,
      parent,
      options ?? { mapSubfolders: false, lookups: { lookup: 'none' } },
    )
  return {
    target: parent,
    documentKind: parent.documentKind ?? guessDocumentKind(item.name),
  }
}

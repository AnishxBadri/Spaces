import { Option, Schema } from 'effect'
import type { ColumnSizingState, VisibilityState } from '@tanstack/react-table'
import { plainRecord } from '#/lib/plain-record'

export type TablePrefs = {
  columnVisibility: VisibilityState
  columnSizing: ColumnSizingState
}

/** localStorage is a boundary like any other: decoded, never asserted. */
const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      columnVisibility: Schema.optional(plainRecord(Schema.Boolean)),
      columnSizing: Schema.optional(plainRecord(Schema.Finite)),
    }),
  ),
)

/**
 * A table's stored column state, from its localStorage string. Nothing
 * stored, a string that is not JSON, or one that fails anywhere reads as
 * no state at all: every column shown, every width the default.
 */
export function tablePrefsOf(raw: string | null): TablePrefs {
  return Option.match(decodeStored(raw ?? '{}'), {
    onNone: () => ({ columnVisibility: {}, columnSizing: {} }),
    onSome: (stored) => ({
      columnVisibility: { ...stored.columnVisibility },
      columnSizing: { ...stored.columnSizing },
    }),
  })
}
